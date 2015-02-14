var nconf = require('nconf');
var azure = require('azure-storage');

nconf.env().file({ file: 'config.json' });

var storageAccount = nconf.get("STORAGE_ACCOUNT");
var storageAccessKey = nconf.get("STORAGE_ACCESS_KEY");

var sendgridApiUser = nconf.get("SENDGRID_API_USER");
var sendgridApiKey = nconf.get("SENDGRID_API_KEY");
var sendgrid = require('sendgrid')(sendgridApiUser, sendgridApiKey);

var userModel = require('../models/user')({storageAccount: storageAccount, storageAccessKey: storageAccessKey});
    
exports.signup = function (req, res, message)
{
    var page = "signup";
    var locals = { session: req.session, post: req.body };
    
    var post = req.body;
    if (post && post.email)
    {
        userModel.getUser(post.email, function (err, user)
        {
            if (err)
            {
                req.flash("warn", "Error checking to see if account already existed");
                res.render(page, locals);
            }
            else if (user)
            {
                req.flash("warn", "An account with that email address already exists");
                res.render(page, locals);
            }
            else
            {
                userModel.createUser(post.email, post.password, function (err, user)
                {
                    if (!err)
                    {
                        req.flash("info", "Account created");
                        req.session.userid = user.email;
                        var nextPage = "/"; // default
                        if (req.session.nextPage)
                        {
                            nextPage = req.session.nextPage;
                            req.session.nextPage = null;
                        }
                        res.redirect(nextPage);
                    }
                    else
                    {
                        req.flash("warn", "Account could not be created");
                        res.render(page, locals);
                    }
                });
            }
        });
    }
    else
    {
        res.render(page, locals);
    }
};

exports.login = function(req, res, message)
{
    var page = "login";
    var locals = { session: req.session, post: req.body };
    
    var post = req.body;
    if (post && post.email)
    {
        userModel.getUser(post.email, function (err, user)
        {
            if (err)
            {
                req.flash("warn", "Error verifying email address and password");
                res.render(page, locals);
            }
            else if (!user)
            {
                // User didn't exists
                req.flash("warn", "Email address and password combination were not correct");
                res.render(page, locals);
            }
            else
            {
                if (user.isPasswordValid(post.password))
                {
                    // Winner!
                    req.session.userid = user.email;
                    var nextPage = "/"; // default
                    if (req.session.nextPage)
                    {
                        nextPage = req.session.nextPage;
                        req.session.nextPage = null;
                    }
                    res.redirect(nextPage);
                }
                else
                {
                    // Invalid password
                    req.flash("warn", "Email address and password combination were not correct");
                    res.render(page, locals);
                }
            }
        });
    }
    else
    {
        res.render(page, locals);
    }
};

exports.logout = function(req, res)
{
    delete req.session.userid;
    req.flash("info", "You have been signed out");
    res.redirect('/');
}

exports.checkAuth = function(req, res, next) 
{
    if (!req.session.userid)
    {
        req.flash("info", "The page you have attempted to access requires that you be signed in")
        req.session.nextPage = req.path;
        res.redirect('login');
    }
    else 
    {
        next();
    }
}

exports.getSecret = function (req, res, next)
{
    if (req.query.email && req.query.password)
    {
        userModel.getUser(req.query.email, function (err, user)
        {
            if (err)
            {
                res.statusCode = 401;
                res.send('Authentication Error');
            }
            else if (!user)
            {
                // User didn't exists
                res.statusCode = 401;
                res.send('Authentication failed');
            }
            else
            {
                if (user.isPasswordValid(req.query.password))
                {
                    // Winner!
                    res.json({ email: user.email, secret: user.secret });
                }
                else
                {
                    // Invalid password
                    res.statusCode = 401;
                    res.send('Authentication failed');
                }
            }
        });
    }
    else
    {
        // Invalid password
        res.statusCode = 401;
        res.send('Authentication failed, credentials not supplied');
    }
}

exports.changePassword = function (req, res, next)
{
    // !!! require logged in
    
    var page = "changepass";
    var locals = { session: req.session, post: req.body };

    if (req.method == "POST")
    {
        if (!req.body.password)
        {
            req.flash("warn", "Password, new password, and new password verification are all required");
            res.render(page, locals);
        }
        else if (req.body.newpassword != req.body.newpassword2)
        {
            req.flash("warn", "New password and new password verification are not the same");
            res.render(page, locals);
        }
        else
        {
            userModel.getUser(req.session.userid, function (err, user)
            {
                if (err)
                {
                    req.flash("warn", "Error looking up logged in user");
                    res.render(page, locals);
                }
                else if (!user)
                {
                    // User didn't exists
                    req.flash("warn", "Error looking up user logged in user, account not found");
                    res.render(page, locals);
                }
                else
                {
                    // Got logged-in user
                    //
                    if (user.isPasswordValid(req.body.password))
                    {
                        user.setPassword(req.body.newpassword);
                        user.update(function (err)
                        {
                            if (err)
                            {
                                req.flash("warn", "Error update password");
                                res.render(page, locals);
                            }
                            else
                            {
                                req.flash("info", "Password successfully updated");
                                res.redirect("/");
                            }
                        });
                    }
                    else
                    {
                        req.flash("warn", "Current password was not correct");
                        res.render(page, locals);
                    }
                }
            });
        }
    }
    else
    {
        res.render('changepass', { session: req.session });
    }
}

exports.verifyAccount = function (req, res, next)
{
    var page = "verify";    
    var params = (req.method == "POST" ? req.body : req.query);
    var locals = { session: req.session, post: params };

    if ((req.method == "POST")  && !req.body.code)
    {
        // POST with no code (error)...
        //
        req.flash("warn", "Verification code is required");
        res.render(page, locals);
    }
    else if (!params.code)
    {
        // GET with no code...
        //
        res.render(page, locals);
    }
    else
    {
        // We have a code!
        //
        // !!! If not logged in, we need to force login (either on this form, or redirect w/ "next")
        //
        // !!! Check the code
        //
        res.render(page, locals);
    }
}

exports.forgotPassword = function (req, res, next)
{
    var page = "forgot";
    var locals = { session: req.session, post: req.body };
    
    var post = req.body;
    if (post && post.email)
    {
        userModel.getUser(post.email, function (err, user)
        {
            if (err)
            {
                req.flash("warn", "Error verifying email address");
                res.render(page, locals);
            }
            else if (!user)
            {
                // User didn't exists
                req.flash("warn", "No account exists with the provided email address");
                res.render(page, locals);
            }
            else
            {
                // Winner!
                
                // !!! Need to generate a recovery uuid, jam it in the db, then put a link in the message in the form:
                //     /[host]/reset?code=[recovery code]

                var message = 
                {
                    to: user.email,
                    from: 'webadmin@synchro.io',
                    subject: 'Synchro.io Password Reset',
                    text: 'OK, go ahead and reset your password'
                }
                
                sendgrid.send(message, function (err, json)
                {
                    if (err)
                    {
                        req.flash("warn", "Failed to send password reset email message");
                        res.render(page, locals);
                    }
                    else
                    {
                        req.flash("info", "Password reset email sent");
                        var nextPage = "/"; // default
                        if (req.session.nextPage)
                        {
                            nextPage = req.session.nextPage;
                            req.session.nextPage = null;
                        }
                        res.redirect(nextPage);
                    }
                });               
            }
        });
    }
    else
    {
        res.render(page, locals);
    }
}

exports.resetPassword = function (req, res, next)
{
    var page = "reset";
    var locals = { session: req.session, post: req.body };

    if (req.query.code)
    {
        // !!! verify code, allow reset if valid by rendering pw reset form (hidden form field of "code"?)
    }
    else
    {
        // !!! render form with place for user to provide recovery code
    }

    // !!! Need to handle post (either here or in separate handler)
    res.render(page, locals);
}

var blobService = azure.createBlobService(storageAccount, storageAccessKey);

// For request in the form /dist/[secret]/[filename], we will validate the secret, then attempt to pipe the file of that
// name in our Azure blob store as the response.
//
exports.dist = function (req, res, next)
{
    userModel.getAccountForSecret(req.params.id, function (err, user)
    {
        if (err)
        {
            // Error
            console.log("dist - getAccountForSecret error:", err);
            res.statusCode = 500;
            res.send('Server Error');
        }
        else if (!user)
        {
            // No matching user found
            res.statusCode = 403;
            res.send('Forbidden, invalid token in path');
        }
        else
        {
            // User found! (might want to check "verified", maybe verify clickwrap agreement, etc, in future)
            //
            blobService.getBlobToStream('dist', req.params.filename, res, function (error)
            {
                // getBlobToStream just happens to propagate all of the content-related headers from the
                // blob request to this response.
                //
                if (!error)
                {
                    res.end();
                }
                else
                {
                    console.log('dist - getBlobToStream error', error);
                    res.code = error.code;
                    res.statusCode = error.statusCode;
                    res.end();
                }
            });
        }
    });
}
