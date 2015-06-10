/**
 * Module dependencies.
 */
var express = require('express');
var expressFlash = require('express-flash');
var http = require('http');
var path = require('path');
var log4js = require('log4js');

var account = require('./routes/account');

// Redirect console.log to log4js, turn off color coding
log4js.configure({ appenders: [ { type: "console", layout: { type: "basic" } } ], replaceConsole: true })

var logger = log4js.getLogger("app");
logger.info("Synchro.io web site loading...");

var app = express();

// all environments
app.set('port', process.env.PORT || 1337);

var hbs = require('express-hbs');

// Use `.hbs` for extensions and find partials in `views/partials`.
app.engine('hbs', hbs.express3({
    partialsDir: __dirname + '/views/partials',
    layoutsDir: __dirname + '/views/layouts',
    defaultLayout: __dirname + '/views/layouts/default.hbs',
    contentHelperName: 'content'
}));
app.set('view engine', 'hbs');
app.set('views', __dirname + '/views');

app.use(express.cookieParser());
app.use(express.cookieSession({ key: 'synchro_session', secret: 'sdf89f89fd7sdf7sdf', cookie: { domain: account.isSynchroIo() ? '.synchro.io' : null, httpOnly: false, maxAge: 31 * 24 * 60 * 60 * 1000 } })); // 31 days, in milliseconds
app.use(expressFlash());
app.use(express.favicon());

// Log4js logger - nolog for /getsecret (so we don't expose email/password URL params in logs)
//
app.use(log4js.connectLogger(logger, { level: 'auto', nolog: '^/getsecret' }));
//app.use(express.logger('dev'));

app.use(express.query());
app.use(express.json());
app.use(express.urlencoded());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public')));

// development only
if ('development' == app.get('env')) {
  app.use(express.errorHandler());
}

// Main content pages
//
app.get('/', function (req, res) 
{
    var locals = { session: req.session, pageIndex: true };
    
    // For device/os detection we originally used: https://www.npmjs.com/package/mobile-detect, but
    // it didn't support Windows, so we roll our own (not too bad since all we care about is the OS).
    //
    // For user-agent guidance and samples, see: http://www.webapps-online.com/online-tools/user-agent-strings/dv
    //
    // !!! We'll use this to drive display of the "download mobile client from app store" link on the main page.
    //
    var ua = req.headers['user-agent'] || "";
    if (ua.match(/iPod|iPad|iPhone/))
    {
        locals.os = "iOS";
    }
    else if (ua.match(/Android/))
    {
        locals.os = "Android";
    }
    else if (ua.match(/Windows NT 6[.][23]|Windows Phone 8[.][01]/))
    {
        locals.os = "Windows";
    }

    res.render('index', locals );
});
app.get('/getstarted', function (req, res)
{
    res.render('getstarted', { session: req.session, pageGetstarted: true });
});
app.get('/technology', function (req, res)
{
    res.render('technology', { session: req.session, pageTechnology: true });
});
app.get('/pricing', function (req, res)
{
    res.render('pricing', { session: req.session, pagePricing: true });
});

app.get('/about', function (req, res)
{
    res.render('about', { session: req.session });
});
app.get('/privacy', function (req, res)
{
    res.render('site_privacy', { session: req.session });
});
app.get('/appprivacy', function (req, res)
{
    res.render('app_privacy', { session: req.session });
});

// Login/logout
//
app.all('/login', account.login);
app.get('/logout', account.logout);
app.all('/zd/login', account.zendeskLogin);
app.all('/zd/logout', account.zendeskLogout);

// Sign up and verify
//
app.all('/signup', account.signup);
app.all('/signup-complete', function (req, res)
{
    res.render('signup_complete', { session: req.session });
});
app.all('/verify', account.verifyAccount);
app.all('/verify-complete', function (req, res)
{
    // Tne "nextPage" (if any) is left over from the original login/signup action, and will allow the user
    // to continue on (back) to that page after verification.
    //
    var nextPage = null;
    if (req.session.nextPage)
    {
        nextPage = req.session.nextPage;
        req.session.nextPage = null;
    }
    res.render('verify_complete', { session: req.session, nextPage: nextPage });
});

// Account management
//
app.all('/account', account.requireSignedIn, account.manageAccount);
app.all('/changeemail', account.requireSignedIn, account.changeEmail);
app.all('/changepass', account.requireSignedIn, account.changePassword);
app.all('/resend', account.requireSignedIn, account.resendVerification);
app.all('/forgot', account.forgotPassword);
app.all('/reset',  account.resetPassword);
app.all('/license', account.license);

// CLI auth endpoint
//
app.all('/getsecret', account.getSecret);

// CLI download endpoint
//
app.get('/dist/:id/:filename', account.dist);

// The Server...
//
var server = http.createServer(app);
server.listen(app.get('port'), function(){
    logger.info('Express server listening on port ' + app.get('port') + ", node version: " + process.version);
});
