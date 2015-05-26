var nconf = require('nconf');
var azure = require('azure-storage');

var analytics = require('universal-analytics');

// Require for Zendesk JWT SSO
//
var uuid = require('node-uuid');
var url = require('url');
var jwt = require('jwt-simple');

var logger = require('log4js').getLogger("account");

nconf.env().file({ file: 'config.json' });

var storageAccount = nconf.get("STORAGE_ACCOUNT");
var storageAccessKey = nconf.get("STORAGE_ACCESS_KEY");

var sendgridApiUser = nconf.get("SENDGRID_API_USER");
var sendgridApiKey = nconf.get("SENDGRID_API_KEY");
var sendgrid = require('sendgrid')(sendgridApiUser, sendgridApiKey);

var zendeskSubdomain = nconf.get("ZENDESK_SUBDOMAIN");
var zendeskSharedKey = nconf.get("ZENDESK_SHARED_KEY");
var zendeskApiAccount = nconf.get("ZENDESK_API_ACCOUNT");
var zendeskApiToken = nconf.get("ZENDESK_API_TOKEN");
var zendeskUri = 'https://' + zendeskSubdomain + '.zendesk.com/';

var userModel = require('../models/user')({storageAccount: storageAccount, storageAccessKey: storageAccessKey});

var zendeskModel = require('../models/zendesk')({apiAccount: zendeskApiAccount, apiToken: zendeskApiToken, subdomain: zendeskSubdomain});

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
    session.username = user.name;
    session.userid = user.userid;
    session.email = user.email;
    session.verified = user.verified;
    session.licenseAgreed = user.licenseAgreed;
}

function clearSessionUser(session, res)
{
    // This will still leave other session (session cookie) values, like flash messages, 
    // nextPage, etc, just FYI.
    //    
    delete session.username;    
    delete session.userid;
    delete session.email;
    delete session.verified;
    delete session.licenseAgreed;
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
        text: 'An account on Synchro.io has been associated with this email address.  The verification code is: ' + user.verificationCode + '.  To verify this email address, go to this page: ' + recoveryLink,
        html: 'An account on Synchro.io has been associated with this email address.  The verification code is: ' + user.verificationCode + '.  <a href="' + recoveryLink + '">Click here to verify this email address</a>',
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
        if (!post.email || !post.password || !post.password2)
        {
            req.flash("warn", "Email, Password, and new Password Verification are all required");
            res.render(page, locals);
        }
        else if (post.password != post.password2)
        {
            req.flash("warn", "Password and password verification are not the same");
            res.render(page, locals);
        }
        else
        {
            userModel.getUserForKey("email", post.email, function (err, user)
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
                    var newUser =
                    {
                        name: post.name, 
                        organization: post.organization,
                        email: post.email, 
                        password: post.password
                    }

                    userModel.createUser(newUser, function (err, user)
                    {
                        if (!err)
                        {
                            setSessionUser(req.session, user, res);
                            
                            // New Synchro user, create a help center user...
                            //
                            zendeskModel.synchUser(user, function (err)
                            {
                                // We're not going to wait on this or make it part of our action chain on new account creation, 
                                // simply because if it fails, it will be automatically resolved the first time the user navigates
                                // to the help center when logged in (that logic will detect that the user is logged in and trigger
                                // an SSO login, which will create this account if it doesn't exist).
                                //
                                // !!! One caveat - If this does fail here in a permanent way (say, for example, that a different user
                                //     exists on the Zendesk side with this same email address), then *maybe* we should do something here,
                                //     since that's going to fail in the same way with the auto-SSO (only uglier - it will actually log
                                //     you out of the main site).
                                //
                                if (err)
                                {
                                    logger.error("Zendesk syncUser error:", err);
                                }
                            });
                               
                            sendVerificationEmail(req, user, function (err, json)
                            {
                                if (err)
                                {
                                    req.flash("warn", "Failed to send account verification email.  Please visit your Account page to resent it.");
                                    logger.error("Sendgrid failure:", err);
                                    res.redirect("/signup-complete");
                                }
                                else
                                {
                                    // We're going to let any "nextPage" sit until the verification complete page, at which
                                    // point you'll have the option to continue on (back) to that page.
                                    //
                                    // Note: Since account creation isn't really complete until the email is verified, we aren't going to follow
                                    //       any nextPage chaining (or bother doing an SSO to ZenDesk).  The user is free, or course, to navigate
                                    //       wherever they want, including the Help Center, before verifying, but we're not going to encourage it.
                                    //
                                    res.redirect("/signup-complete");
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
        
        if (!req.session.nextPage)
        {
            // After login, send them back to whence they came.  Note that if they get to login via a redirect from
            // a page that requires the user to be logged in, the nextPage will already be set.  This particular logic
            // should only apply when the user chooses the login link from the header.
            //
            if (req.headers.referer)
            {
                req.session.nextPage = req.headers.referer;
            }
            else if (req.headers.host && req.headers.host.indexOf("support.synchro.io") == 0)
            {
                // If we're logging in from the login link in the "Synchro" header of our Help Center (not to be
                // confused with logging in from the Help Center via SSO), and for whatever reason we do not have a
                // Referer header to go back to, we need to fully specify the nextPage (we'll chose the landing page
                // of the Help Center).
                //
                req.session.nextPage = "https://support.synchro.io/hc/en-us";
            }
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
        exports.zendeskLogout(req, res);
    }
}

// Zendesk JS API
//
//   Log out via JS: https://support.synchro.io/access/logout.json returns {"success":true}
//   Logged-in user: https://support.synchro.io/api/v2/users/me.json
//

function doZendeskLogin(req, res, return_to)
{
    // For JWT SSO (Zendesk)
    // https://github.com/zendesk/zendesk_jwt_sso_examples/blob/master/node_jwt.js
    // https://github.com/hokaccha/node-jwt-simple
    //
    var session = req.session;
    var payload = 
    {
        iat: (new Date().getTime() / 1000),
        jti: uuid.v4(),
        external_id: session.userid,
        name: session.username || session.email,
        email: session.email
    };
    
    // logger.info("Logging in to ZenDesk with external_id: " + payload.external_id + " and email address: " + payload.email);

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
    var direct = query['direct'] != null;

    var session = req.session;
    if (!session.userid)
    {
        // Not logged in to our site, so go log in now...
        //
        // We don't want to do the message below on the straight up "clicked login from help center
        // menu bar" case ("direct")...
        //
        if (return_to && !direct)
        {
            req.flash("info", "The Help Center function you have selected requires you to be signed in");
        }
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
    
    // Sometimes Zendesk freaks out due to some condition it doesn't like in SSO (typically when there is a data consistency
    // issue - like you're SSOing in with an external_id and email address, and a different ZenDesk user already has that email
    // adddress) - and when that happens, it just goes right to the logout endpoint, indicating an error in the "kind" query param
    // and the details of the error in the "message" query param.  We need to display that to the user, so they at least have some
    // kind of explanation of their spontaneous logout to give to Synchro support.
    //
    if (req.query.kind == "error")
    {
        req.flash("warn", "Error - " + req.query.message);
    }

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
            locals.user = user;
            
            if (req.method == "POST")
            {
                var post = req.body;

                // Got logged-in user
                //
                user.name = post.name;
                user.organization = post.organization;
                user.update(function (err)
                {
                    if (err)
                    {
                        req.flash("warn", "Error updating account information");
                        res.render(page, locals);
                    }
                    else
                    {
                        setSessionUser(req.session, user, res);
                        
                        // Potential user name change...
                        //
                        zendeskModel.synchUser(user, function (err)
                        {
                            if (err)
                            {
                                req.flash("warn", "Error synchronizing user with help center");
                            }
                            else
                            {
                                req.flash("info", "Account information successfully updated");
                            }
                            res.render(page, locals);
                        });
                    }
                });
            }
            else
            {
                locals.post = { name: user.name, organization: user.organization };
                res.render(page, locals);
            }
        }
    });
}

exports.license = function (req, res, next)
{
    var page = "license";
    var locals = { session: req.session, post: req.body };
    
    if (!req.session.userid)
    {
        // Not logged in - show read-only (no form) version...
        res.render(page, locals);
    }
    else
    {
        // Logged in user
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
                locals.user = user;
                
                if (req.method == "POST")
                {
                    var post = req.body;
                    
                    if (!post.licenseAgreedName)
                    {
                        req.flash("warn", "Name of person agreeing to agreement is required");
                        res.render(page, locals);
                    }
                    else
                    {
                        user.setLicenseAgreed(post.licenseAgreedName, post.licenseAgreedTitle, post.licenseAgreedOrganization, post.licenseAgreedVersion);
                        user.update(function (err)
                        {
                            if (err)
                            {
                                req.flash("warn", "Error updating agreement to license");
                            }
                            else
                            {
                                setSessionUser(req.session, user, res);
                                req.flash("info", "License Agreement successfully executed");
                            }
                            res.render(page, locals);
                        });
                    }
                }
                else
                {
                    locals.post = { licenseAgreedName: user.name, licenseAgreedOrganization: user.organization };
                    res.render(page, locals);
                }
            }
        });
    }
}

exports.changeEmail = function (req, res, next)
{
    var page = "changeemail";
    var locals = { session: req.session, post: req.body };

    if (req.method == "POST")
    {
        if (!req.body.newemail || !req.body.newemail2 || !req.body.password)
        {
            req.flash("warn", "New email address, new email address verification, and password are all required");
            res.render(page, locals);
        }
        else if (req.body.newemail != req.body.newemail2)
        {
            req.flash("warn", "New email address and new email address verification are not the same");
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
                    req.flash("warn", "Error looking up user logged in user, account not found");
                    res.render(page, locals);
                }
                else
                {
                    // Got logged-in user
                    //
                    if (user.isPasswordValid(req.body.password))
                    {
                        if (user.email == req.body.newemail)
                        {
                            req.flash("warn", "Account email address is already set to the specified address");
                            res.render(page, locals);
                        }
                        else
                        {
                            userModel.getUserForKey("email", req.body.newemail, function (err, user2)
                            {
                                if (err)
                                {
                                    req.flash("warn", "Error checking to see if account with the specified email address already existed");
                                    res.render(page, locals);
                                }
                                else if (user2)
                                {
                                    req.flash("warn", "An account with that email address already exists");
                                    res.render(page, locals);
                                }
                                else
                                {
                                    user.email = req.body.newemail;
                                    user.setVerified(false);
                                    user.update(function (err)
                                    {
                                        if (err)
                                        {
                                            req.flash("warn", "Error updating email address");
                                            res.render(page, locals);
                                        }
                                        else
                                        {
                                            setSessionUser(req.session, user, res);
                                            
                                            // Email address change...
                                            //
                                            zendeskModel.synchUser(user, function (err)
                                            {
                                                if (err)
                                                {
                                                    req.flash("warn", "Email address updated, but failed to synchronize with user email identity in help center, no account verification message sent");
                                                    res.render(page, locals);
                                                }
                                                else
                                                {
                                                    sendVerificationEmail(req, user, function (err, json)
                                                    {
                                                        if (err)
                                                        {
                                                            req.flash("warn", "Email address updated, but failed to send account verification message");
                                                            logger.error("Sendgrid failure:", err);
                                                            
                                                            // In this specified failure case, we redirect to the "account" page, since it has a 
                                                            // "resend verification" button.
                                                            //
                                                            res.redirect("/account");
                                                        }
                                                        else
                                                        {
                                                            // Change email address should always be coming from "account", so we'll go back the (and
                                                            // skip the nextPage business).
                                                            //
                                                            req.flash("info", "Email address successfully updated and verification message sent");
                                                            res.redirect("/account")
                                                        }
                                                    });
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        }
                    }
                    else
                    {
                        req.flash("warn", "Password was not correct");
                        res.render(page, locals);
                    }
                }
            });
        }
    }
    else
    {
        res.render('changeemail', { session: req.session });
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
                                // We'll return to "account" on success, since that's the only place we could have come
                                // from (don't need to use nextPage for that).
                                //
                                req.flash("info", "Password successfully updated");
                                res.redirect("/account");
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
                    user.setVerified(true);
                    user.update(function (err)
                    {
                        if (err)
                        {
                            req.flash("warn", "Error saving user account verification");
                            res.render(page, locals);
                        }
                        else if (req.session.userid) // Currently logged in
                        {
                            if (req.session.userid == user.userid)
                            {
                                // Validated for logged in user
                                //
                                setSessionUser(req.session, user, res); // update verification in session
                                
                                if (!req.session.nextPage && (req.headers.referer && req.headers.referer.indexOf("/account") >= 0))
                                {
                                    // If we came from "account", we want to be able to continue back there after confirmation 
                                    // of verification.
                                    //
                                    req.session.nextPage = "/account";
                                }

                                res.redirect('/verify-complete');
                            }
                            else
                            {
                                // Validated for different user than logged in user
                                req.session.nextPage = null;
                                req.flash("info", "The verified address was not for the currently logged in account");
                                res.redirect('/verify-complete');
                            }
                        }
                        else // Not currently logged in
                        {
                            // Validated, but not currently logged in
                            //
                            req.session.nextPage = null;
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
            res.redirect('back');
        }
        else if (!user)
        {
            // User didn't exists
            req.flash("warn", "Error looking up user logged in user, account not found");
            res.redirect('back');
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
                    logger.error("Sendgrid failure:", err);
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
                                logger.error("Sendgrid failure:", err);
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
                            logger.errro("Error updating account on recovery:", err);
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
                    if (!user.verified)
                    {
                        res.statusCode = 403;
                        res.send('Forbidden, user has not yet verified account email address on the synchro.io website');
                    }
                    else if (!user.licenseAgreed)
                    {
                        res.statusCode = 403;
                        res.send('Forbidden, user has not yet agreed to the license agreement on the synchro.io website');
                    }
                    else
                    {
                        // Winner!
                        res.json({ email: user.email, secret: user.secret });
                    }
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
            logger.error("dist - getUserForKey[secret] error:", err);
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
            if (!user.licenseAgreed)
            {
                res.statusCode = 403;
                res.send('Forbidden, user has not yet agreed to the license agreement on the synchro.io website');
            }
            else
            {
                // Attempt download...
                //

                // Notify Google Analytics
                var visitor = analytics('UA-62082932-1', user.userid);
                visitor.pageview("/dist/" + req.params.filename).send();
                
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
                        logger.error('dist - getBlobToStream error', error);
                        res.code = error.code;
                        res.statusCode = error.statusCode;
                        res.end();
                    }
                });
            }
        }
    });
}
