var zendesk = require('node-zendesk');

var logger = require('log4js').getLogger("zendesk");

module.exports = function (params)
{
    var client = zendesk.createClient(
    {
        username: params.apiAccount,
        token: params.apiToken,
        remoteUri: 'https://' + params.subdomain + '.zendesk.com/api/v2'
    });
    
    // https://github.com/blakmatrix/node-zendesk/issues/91
    //
    client.useridentities.updateValue = function (userID, userIDentityID, value, cb)
    {
        this.request('PUT', ['users', userID, 'identities', userIDentityID], { "identity": { "value": value } }, cb);
    };
    
    function updateEmail(zendeskId, email, cb)
    {
        logger.info("Zendesk - Updating email address to:", email);
        client.useridentities.list(zendeskId, function (err, req, result)
        {
            if (err)
            {
                cb(err);
            }
            else
            {
                var emailIdentity = null;
                
                for (var i = 0; i < result.length; i++)
                {
                    logger.debug("Zendesk - Found identity:", JSON.stringify(result[i], null, 2, true));
                    if (result[i].type == "email")
                    {
                        emailIdentity = result[i];
                        break;
                    }
                }
                
                if (emailIdentity)
                {
                    logger.debug("Zendesk - Found existing email identity, updating it");
                    
                    // Update existing identity with new email address
                    client.useridentities.updateValue(zendeskId, emailIdentity.id, email, function (err, req, result)
                    {
                        // !!!
                        if (err)
                        {
                            cb(err);
                        }
                        else
                        {
                            logger.debug("Zendesk - User idenity value updated");
                            cb();
                        }
                    });
                }
                else
                {
                    logger.debug("Zendesk - No email identity found, adding one");
                    
                    // Add new email identity
                    emailIdentity = { "type" : "email", "value" : email, "verified": true };
                    client.useridentities.create(zendeskId, emailIdentity, function (err, req, result)
                    {
                        // !!!
                        if (err)
                        {
                            cb(err);
                        }
                        else
                        {
                            logger.debug("Zendesk - User idenity value added");
                            cb();
                        }
                    });
                }
            }
        });
    }

    var zendeskModel = 
    {
        synchUser: function (user, cb)
        {
            // user fields: userid, email, name
            //
            logger.info("Zendesk - Sync user:", user);
            
            // Find Zendesk user by our userId (the Zendesk "external_id")
            //
            client.users.search("?external_id=" + user.userid, function (err, req, result)
            {
                // I swear I have seen the case where a properly formed request returns a 404 error when no Zendesk user is found. 
                // But today, it appears that it just happily returns an empty result set in that case.  So We'll just accomodate
                // both and hope to god it doesn't change again...
                //
                if ((err && (err.statusCode == 404)) || (!err && (result.length == 0)))
                {
                    // Did not find the user, so we'll add a new one...
                    //
                    logger.debug("Zendesk - No user found, adding one...");
                    
                    var zendeskUser = { "external_id": user.userid, "name": user.name, "email": user.email, "verified": true };
                    client.users.create({ "user": zendeskUser }, function (err, req, result)
                    {
                        if (err)
                        {
                            var result = JSON.parse(err.result.toString('utf8'));
                            
                            // A somewhat common error condition is trying to add a Zendesk user when another user already
                            // exists with the same email address.  When you do that, the result is as follows:
                            /*                   
                            {
                                "error":"RecordInvalid",
                                "description":"Record validation errors",
                                "details":
                                {
                                    "email":
                                    [
                                        {
                                            "description": "Email: bob.dickinson@gmail.com is already being used by another user",
                                            "error": "DuplicateValue"
                                        }
                                    ]
                                }
                            }
                            */
                            // The statusCode is 422 ("Unprocessable Entity")
                            //
                            // I have no idea how you could be expected to process that pile of shit into something worthy
                            // of displaying to an end user.  So the details is a dictionary, of, types of invalid records?  Where
                            // each type has a collection of errors of that type?  Does "email' represent the entity called "email"?
                            // Who knows.
                            //
                            logger.error("Zendesk - Result:", JSON.stringify(result));
                            cb(err);
                        }
                        else
                        {
                            cb();
                        }
                    });
                }
                else if (!err)
                {
                    // Found the user, so let's update it as needed...
                    //
                    logger.info("Zendesk returned:", JSON.stringify(result, null, 2, true))
                    var zendeskUser = result[0];
                    logger.debug("Zendesk - Found user:", JSON.stringify(zendeskUser, null, 2, true));
                    
                    if (zendeskUser.name != user.name)
                    {
                        // Update user with name
                        //
                        logger.debug("Zendesk - Updating user with changed name:", user.name);
                        
                        client.users.update(zendeskUser.id, { "user": { "name": user.name } }, function (err, req, result)
                        {
                            if (err)
                            {
                                cb(err);
                            }
                            else // User name updated
                            {
                                // See if email needs to be updated too...
                                //
                                if (zendeskUser.email != user.email)
                                {
                                    // Update email address
                                    updateEmail(zendeskUser.id, user.email, cb);
                                }
                                else
                                {
                                    // No email address change, so we're done
                                    cb();
                                }
                            }
                        });

                    }
                    else if (zendeskUser.email != user.email)
                    {
                        // Update email address
                        updateEmail(zendeskUser.id, user.email, cb);
                    }
                    else
                    {
                        // No update required
                        cb();
                    }
                }
                else
                {
                    // Protocol error
                    //
                    logger.error("Zendesk API request error:", err);
                    cb(err);
                }
            });
        }
    }
    return zendeskModel;
}
