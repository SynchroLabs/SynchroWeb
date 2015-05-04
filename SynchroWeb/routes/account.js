var nconf = require('nconf');
var azure = require('azure-storage');

var analytics = require('universal-analytics');

// Require for Zendesk JWT SSO
//
var uuid = require('node-uuid');
var url = require('url');
var jwt = require('jwt-simple');

nconf.env().file({ file: 'config.json' });

var storageAccount = nconf.get("STORAGE_ACCOUNT");
var storageAccessKey = nconf.get("STORAGE_ACCESS_KEY");

var sendgridApiUser = nconf.get("SENDGRID_API_USER");
var sendgridApiKey = nconf.get("SENDGRID_API_KEY");
var sendgrid = require('sendgrid')(sendgridApiUser, sendgridApiKey);

var zendeskSubdomain = nconf.get("ZENDESK_SUBDOMAIN");
var zendeskSharedKey = nconf.get("ZENDESK_SHARED_KEY");
var zendeskUri = 'https://' + zendeskSubdomain + '.zendesk.com/';

var userModel = require('../models/user')({storageAccount: storageAccount, storageAccessKey: storageAccessKey});

function isSynchroIo()
{
    return nconf.get("WEBSITE_DOMAIN") == "synchro.io";
}

exports.isSynchroIo = function ()
{
    return isSynchroIo();
}

function setSessionUser(session, user, res)
{
    session.userid = user.userid;
    session.email = user.email;
    session.verified = user.verified;

    // !!! Let Google Anaytics know the userid
}

function clearSessionUser(session, res)
{
    // This will still leave other session (session cookie) values, like flash messages, nextPage, etc, just FYI
    delete session.userid;
    delete session.email;
    delete session.verified;
}

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
    if (post && post.username)
    {
        userModel.getUserForKey("email", post.username, function (err, user)
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
                userModel.createUser(post.username, post.password, function (err, user)
                {
                    if (!err)
                    {
                        setSessionUser(req.session, user, res);                        
                        
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
                                // We're going to let any "nextPage" sit until the verification complete page, at which
                                // point you'll have the option to continue on (back) to that page.
                                //
                                res.redirect("/signup-complete")
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
    if (post && post.username)
    {
        userModel.getUserForKey("email", post.username, function (err, user)
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
                    setSessionUser(req.session, user, res);
                    
                    var nextPage = "/"; // default
                    if (req.headers.host.indexOf("support.synchro.io") == 0)
                    {
                        // If we're logging in from our ZenDesk Help Center, we need to fully specify the default
                        // next page (so we don't end up at support.synchro.io instead of synchro.io).
                        nextPage = "https://synchro.io/";
                    }

                    if (req.session.nextPage)
                    {
                        nextPage = req.session.nextPage;
                        req.session.nextPage = null;
                    }
                    
                    // Only do ZenDesk SSO if configured...
                    //                    
                    if (zendeskSharedKey)
                    {
                        // !!! This only seems to log in to Zendesk if nextPage is in the Help Center (opened ticked with ZenDesk about this)
                        //
                        doZendeskLogin(req, res, nextPage);
                    }
                    else
                    {
                        res.redirect(nextPage);
                    }
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
        if (req.session.loginAs)
        {
            locals.post = { email: req.session.loginAs };
            delete req.session.loginAs;
        }

        res.render(page, locals);
    }
};

exports.logout = function(req, res)
{
    if (zendeskSharedKey)
    {
        // On logout from our site we redirect to: <subdomain>.zendesk.com/access/logout, which
        // will log the user of Zendesk, then in turn redirect to the logout endpoint we defined
        // in Zendesk, which resolves to the zendeskLogout function below.
        //
        var redirect = zendeskUri + 'access/logout';
        res.redirect(redirect);
    }
    else
    {
        // Not integrated with ZenDesk - go straigh to real logout...
        //
        zendeskLogout(req, res);
    }
}

// For JWT SSO (Zendesk)
// https://github.com/zendesk/zendesk_jwt_sso_examples/blob/master/node_jwt.js
// https://github.com/hokaccha/node-jwt-simple
//

// Logout from JS: https://gist.github.com/skipjac/1027314 (???)
//
//     Doing: https://support.synchro.io/access/logout.json?callback=zendeskLogout
//     Navigates to: https://support.synchro.io/access/logout?callback=zendeskLogout&format=json&logout_domains%5B%5D=STOP
//     Which emits: zendeskLogout({"success":true})
//
// Logged-in user: https://support.synchro.io/api/v2/users/me.json


function doZendeskLogin(req, res, return_to)
{
    console.log("Host: " + req.headers.host);
    var session = req.session;
    var payload = 
    {
        iat: (new Date().getTime() / 1000),
        jti: uuid.v4(),
        name: session.username || session.email,
        email: session.email
    };
    
    // Encode payload and redirect to Zendesk login endpoint...
    //
    var token = jwt.encode(payload, zendeskSharedKey);
    var redirect = zendeskUri + 'access/jwt?jwt=' + token;
    if (return_to)
    {
        redirect += '&return_to=' + encodeURIComponent(return_to);
    }    
    res.writeHead(302, { 'Location': redirect });
    res.end();
}

exports.zendeskLogin = function(req, res)
{
    // Zendesk: "This is the URL that Zendesk will redirect your users to for remote authentication"
    //    
    var query = url.parse(req.url, true).query;
    var return_to = query['return_to'];

    var session = req.session;
    if (!session.userid)
    {
        // Not logged in to our site, so go log in now...
        //
        session.nextPage = return_to;
        exports.login(req, res);
    }
    else
    {
        doZendeskLogin(req, res, return_to);
    }
}

exports.zendeskLogout = function(req, res)
{
    // Zendesk: "This is the URL that Zendesk will redirect your users to after they sign out"
    //
    clearSessionUser(req.session, res);
    req.flash("info", "You have been signed out");
    res.redirect('/');
}

exports.requireSignedIn = function(req, res, next) 
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

exports.manageAccount = function (req, res, next)
{
    var page = "account";
    var locals = { session: req.session, post: req.body };
    
    if (req.method == "POST")
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
                // !!! Update account info (username/organization) from post here...
                //
                user.update(function (err)
                {
                    if (err)
                    {
                        req.flash("warn", "Error updating account information");
                        res.render(page, locals);
                    }
                    else
                    {
                        req.flash("info", "Account information successfully updated");
                        res.render(page, { session: req.session }); // !!! Locals?
                    }
                });
            }
        });
    }
    else
    {
        res.render(page, { session: req.session });
    }
}

exports.changePassword = function (req, res, next)
{
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
    var page = "verify";    
    var params = (req.method == "POST" ? req.body : req.query);
    var locals = { session: req.session, post: params };
    
    if (params.code)
    {
        // We have a code!
        //
        userModel.getUserForKey("verificationCode", params.code, function (err, user)
        {
            if (err)
            {
                req.flash("warn", "Error looking up account for verification");
                res.render(page, locals);
            }
            else if (!user)
            {
                // User didn't exists
                req.flash("warn", "No account exists for the supplied verification code");
                res.render(page, locals);
            }
            else
            {
                // Got user
                //
                if (user.verified)
                {
                    req.flash("warn", "The account email address: " + user.email + " has been previously verified");
                    res.redirect('/');
                }
                else
                {   
                    user.setVerified();
                    user.update(function (err)
                    {
                        if (err)
                        {
                            req.flash("warn", "Error saving user account verification");
                            res.render(page, locals);
                        }
                        else if (req.session.userid && (req.session.userid != user.userid))
                        {
                            req.flash("info", "The verified address was not for the currently logged in account");
                            res.redirect('/verify-complete');
                        }
                        else
                        {
                            if (req.session.userid && (req.session.userid == user.userid))
                            {
                                setSessionUser(req.session, user, res); // update verification in session
                            }
                            res.redirect('/verify-complete');
                        }
                    });
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

exports.resendVerification = function (req, res, next)
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
            sendVerificationEmail(req, user, function (err, json)
            {
                if (err)
                {
                    req.flash("warn", "Failed to send account verification email");
                    console.log("Sendgrid failure:", err);
                }
                else
                {
                    req.flash('info', 'Verification email resent');
                }
                res.redirect('back');
            });
        }
    });
}

exports.forgotPassword = function (req, res, next)
{
    var page = "forgot";
    var locals = { session: req.session, post: req.body };

    var post = req.body;
    if (post && post.email)
    {
        userModel.getUserForKey("email", post.email, function (err, user)
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
                user.generateRecoveryCode();
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
                    delete locals.code; // This will force display of the code in the form
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
                            if (req.session.userid && (req.session.userid != user.userid))
                            {
                                req.flash("warn", "The password was reset for an account other than the one to which you were logged in");
                            }
                            
                            req.session.loginAs = req.session.email;
                            clearSessionUser(req.session, res);
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
        if (req.query.code)
        {
            locals.code = req.query.code;
            userModel.getUserForKey("recoveryCode", req.query.code, function (err, user)
            {
                if (err)
                {
                    // Error
                    req.flash("warn", "Error searching for account with specified recovery code");
                    res.render(page, locals);
                }
                else if (!user)
                {
                    // No matching user found
                    delete locals.code; // This will force display of the code in the form
                    locals.post.code = req.query.code; // This will populate the code in the form
                    req.flash("warn", "Recovery code is invalid");
                    res.render(page, locals);
                }
                else
                {
                    // User found!
                    //
                    if (req.session.userid && (req.session.userid != user.userid))
                    {
                        req.flash("warn", "The password reset code corresponds to an account other than the one to which you were logged in");
                        req.session.loginAs = req.session.email;
                        clearSessionUser(req.session, res);
                    }
                    res.render(page, locals);
                }
            });
        }
        else
        {
            res.render(page, locals);
        }
    }
}

// REST API endpoint for use by Synchro command line API
//
exports.getSecret = function (req, res, next)
{
    if (req.query.email && req.query.password)
    {
        userModel.getUserForKey("email", req.query.email, function (err, user)
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
            // User found! 
            //
            // !!! Check verified
            //
            // !!! Notify Google Analytics
            //
            //       - We know account id and can compose a page of /dist/<filename> to make analytics results a little cleaner
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
