
/*
 * GET home page.
 */
var logger = require('log4js').getLogger("index");

exports.index = function (req, res){
    logger.info("Session: %j", req.session);
    res.render('index', { title: 'Synchro', session: req.session });
};