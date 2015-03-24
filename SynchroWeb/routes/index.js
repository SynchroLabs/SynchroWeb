
/*
 * GET home page.
 */

exports.index = function (req, res){
    console.log("Session: ", req.session);
    res.render('index', { title: 'Synchro', session: req.session });
};