var nconf = require('nconf');
var azure = require('azure-storage');

nconf.env().file({ file: 'config.json' });

var storageAccount = nconf.get("STORAGE_ACCOUNT");
var storageAccessKey = nconf.get("STORAGE_ACCESS_KEY");

var sendgridApiUser = nconf.get("SENDGRID_API_USER");
var sendgridApiKey = nconf.get("SENDGRID_API_KEY");
var sendgrid = require('sendgrid')(sendgridApiUser, sendgridApiKey);

var userModel = require('../models/user')({storageAccount: storageAccount, storageAccessKey: storageAccessKey});

// !!! Need menu item that will re-send the verification code (if user not yet verified)

function sendVerificationEmail(req, user, callback)
{
    var host = req.headers.host || "synchro.io";
    var recoveryLink = req.protocol + "://" + host + "/verify?code=" + user.verificationCode;

    var message = 
    {
        to: user.email,
        fromname: 'Synchro Admin',
        from: 'noreply@synchro.io',
        subject: 'Synchro.io Email Verification',
        text: 'An account was created on Synchro.io with this email address.  To verify, go to this page: ' + recoveryLink,
        html: 'An account was created on Synchro.io with this email address.  <a href="' + recoveryLink + '">Click here to verify this email address</a>',
    }
    
    sendgrid.send(message, function (err, json)
    {
        callback(err, json);
    });
}

function sendRecoveryEmail(req, user, callback)
{
    var host = req.headers.host || "synchro.io";
    var recoveryLink = req.protocol + "://" + host + "/reset?code=" + user.recoveryCode;
    
    var message = 
    {
        to: user.email,
        fromname: 'Synchro Admin',
        from: 'noreply@synchro.io',
        subject: 'Synchro.io Password Reset',
        text: 'A password reset for a Synchro.io account was requested for this email address.  To reset your password, go to this page: ' + recoveryLink,
        html: 'A password reset for a Synchro.io account was requested for this email address.  <a href="' + recoveryLink + '">Click here to reset your password</a>',
    }
    
    sendgrid.send(message, function (err, json)
    {
        callback(err, json);
    });
}

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
                        req.session.userid = user.email;
                        
                        sendVerificationEmail(req, user, function (err, json)
                        {
                            if (err)
                            {
                                req.flash("warn", "Failed to send account verification email");
                                console.log("Sendgrid failure:", err);
                                res.render(page, locals);
                            }
                            else
                            {
                                req.flash("info", "Account created and email verification message sent");
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
                    req.session.verified = user.verified;

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

exports.changePassword = function (req, res, next)
{
    // !!! require logged in
    
    var page = "changepass";
    var locals = { session: req.session, post: req.body };

    if (req.method == "POST")
    {
        if (!req.body.password || !req.body.newpassword || !req.body.newpassword2)
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
                                req.flash("warn", "Error updating password");
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
    // !!! require logged in (what if you are logged in under a different account)?

    var page = "verify";    
    var params = (req.method == "POST" ? req.body : req.query);
    var locals = { session: req.session, post: params };
    
    if (params.code)
    {
        // We have a code!
        //
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
                if (params.codd == user.verificationCode)
                {
                    user.setVerified();
                    user.update(function (err)
                    {
                        if (err)
                        {
                            req.flash("warn", "Error saving user account verification");
                            res.render(page, locals);
                        }
                        else
                        {
                            req.flash("info", "Your account email address has been verified");
                            res.redirect('/');
                        }
                    });
                }
                else
                {
                    req.flash("warn", "Incorrect verification code for currently logged in account");
                    res.render(page, locals);
                }
            }
        });
    }
    else if ((req.method == "POST") && !req.body.code)
    {
        // POST with no code (error)...
        //
        req.flash("warn", "Verification code is required");
        res.render(page, locals);
    }
    else
    {
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
                // Found user!
                //
                var recoveryCode = user.generateRecoveryCode();

                var host = req.headers.host || "synchro.io";
                var recoveryLink = req.protocol + "://" + host + "/reset?code=" + recoveryCode;

                user.update(function (err)
                {
                    if (err)
                    {
                        req.flash("warn", "Error saving recovery key to account");
                        res.render(page, locals);
                    }
                    else
                    {
                        sendRecoveryEmail(req, user, function (err, json)
                        {
                            if (err)
                            {
                                req.flash("warn", "Failed to send password reset email message");
                                console.log("Sendgrid failure:", err);
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
        });
    }
    else
    {
        res.render(page, locals);
    }
}

exports.resetPassword = function (req, res, next)
{
    // !!! Investigate - what happens if you are logged in?  Maybe even under a different account than the
    //     one being reset?  Maybe we should log the user out here (since we're going to make then log back
    //     in after the password reset anyway).
    //
    var page = "reset";
    var locals = { session: req.session, post: req.body };
    
    if (req.method == "POST")
    {
        locals.code = req.body.code;
        
        if (!req.body.code)
        {
            req.flash("warn", "Password recovery code is required");
            res.render(page, locals);
        }
        else if (!req.body.newpassword || !req.body.newpassword2)
        {
            req.flash("warn", "New password, and new password verification are both required");
            res.render(page, locals);
        }
        else if (req.body.newpassword != req.body.newpassword2)
        {
            req.flash("warn", "New password and new password verification are not the same");
            res.render(page, locals);
        }
        else
        {
            // Verify that the recovery code is valid
            //
            userModel.getUserForKey("recoveryCode", req.body.code, function (err, user)
            {
                if (err)
                {
                    // Error
                    req.flash("warn", "Error searching for user with specified recovery code");
                    res.render(page, locals);
                }
                else if (!user)
                {
                    // No matching user found
                    req.flash("warn", "Recovery code is invalid");
                    res.render(page, locals);
                }
                else
                {
                    // User found!
                    //
                    user.setPassword(req.body.newpassword);
                    user.clearRecoveryCode();
                    user.update(function (err)
                    {
                        if (err)
                        {
                            req.flash("warn", "Error updating account on recovery");
                            console.log("Error updating account on recovery:", err);
                            res.render(page, locals);
                        }
                        else
                        {
                            req.flash("info", "Password successfully reset, please log in now.");
                            res.redirect('login');
                        }
                    });
                }
            });
        }         
    }
    else
    {
        locals.code = req.query.code;
        res.render(page, locals);
    }
}

// REST API endpoint for use by Synchro command line API
//
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

var blobService = azure.createBlobService(storageAccount, storageAccessKey);

// For request in the form /dist/[secret]/[filename], we will validate the secret, then attempt to pipe the file of that
// name in our Azure blob store as the response.
//
exports.dist = function (req, res, next)
{
    userModel.getUserForKey("secret", req.params.id, function (err, user)
    {
        if (err)
        {
            // Error
            console.log("dist - getUserForKey[secret] error:", err);
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
