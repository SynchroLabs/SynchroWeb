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

var MemoryStore = express.session.MemoryStore;
var sessionStore = new MemoryStore();

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
// Note: Setting the maxAge value to 60000 (one hour) generates a cookie that .NET does not record (date generation/parsing
// is my guess) - for now we just omit expiration...
app.use(express.cookieSession({ store: sessionStore, secret: 'sdf89f89fd7sdf7sdf', cookie: { maxAge: false, httpOnly: true } }));
app.use(expressFlash());
app.use(express.favicon());
app.use(log4js.connectLogger(logger, { level: 'auto' })); //app.use(express.logger('dev'));
app.use(express.query());
app.use(express.json());
app.use(express.urlencoded());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public')));

// development only
if ('development' == app.get('env')) {
  app.use(express.errorHandler());
}

app.get('/', function (req, res) {
    res.render('index');
});
app.all('/login', account.login);
app.get('/logout', account.logout);
app.all('/signup', account.signup);
app.all('/getsecret', account.getSecret);
app.get('/dist/:id/:filename', account.dist);

var server = http.createServer(app);
server.listen(app.get('port'), function(){
    logger.info('Express server listening on port ' + app.get('port') + ", node version: " + process.version);
});
