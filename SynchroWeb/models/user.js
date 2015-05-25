var bcrypt = require('bcryptjs');
var uuid = require('node-uuid');
var azure = require('azure-storage');
var entGen = azure.TableUtilities.entityGenerator;

var logger = require('log4js').getLogger("user-model");

// http://azure.microsoft.com/en-us/documentation/articles/storage-nodejs-how-to-use-table-storage/
// http://dl.windowsazure.com/nodestoragedocs/TableService.html 

module.exports = function (params)
{
    var storageAccount = params.storageAccount;
    var storageAccessKey = params.storageAccessKey;
    
    var tableName = "webuser";
    var partitionKey = "user";
    
    var tableService = azure.createTableService(storageAccount, storageAccessKey);
    
    tableService.createTableIfNotExists('webuser', function (error, result, response)
    {
        if (!error)
        {
            logger.info("Azure webuser table created or already existed");
        }
        else
        {
            logger.error("Azure webuser table did not exist and could not be created:", error);
        }
    });
    
    function User(entity)
    {
        this.entity = entity;
        this.userid = entity.RowKey._;
        this.email = entity.email._;
        this.name = entity.name ? entity.name._ : null;
        this.organization = entity.organization ? entity.organization._ : null;
        this.passwordHash = entity.passwordHash._;
        this.secret = entity.secret._;
        this.verificationCode = entity.verificationCode ? entity.verificationCode._ : null;
        this.verified = entity.verified._;
        this.recoveryCode = entity.recoveryCode ? entity.recoveryCode._ : null;
        this.recoveryCodeIssued = entity.recoveryCodeIssued ? entity.recoveryCodeIssued._ : null;

        this.licenseAgreedDate = entity.licenseAgreedDate ? entity.licenseAgreedDate._ : null;
        this.licenseAgreedName = entity.licenseAgreedName ? entity.licenseAgreedName._ : null;
        this.licenseAgreedTitle = entity.licenseAgreedTitle ? entity.licenseAgreedTitle._ : null;
        this.licenseAgreedOrganization = entity.licenseAgreedOrganization ? entity.licenseAgreedOrganization._ : null;
        this.licenseAgreedVersion = entity.licenseAgreedVersion ? entity.licenseAgreedVersion._ : null;
        this.licenseAgreed = this.licenseAgreedDate != null;
    }
    
    User.prototype.setPassword = function(password)
    {
        this.passwordHash = bcrypt.hashSync(password);
        this.entity.passwordHash = entGen.String(this.passwordHash);
    }    

    User.prototype.isPasswordValid = function(password)
    {
        return bcrypt.compareSync(password, this.passwordHash);
    }
    
    User.prototype.setVerified = function(verified)
    {
        this.verified = verified;
        this.entity.verified = entGen.Boolean(this.verified);
        
        if (this.verified)
        {
            // We're going to leave the verification code even after verifying, so we can detect the case
            // where someone attempts to re-submit a verification (so we can detect the resubmit case vs bad
            // verification code).
            //
            /*
            this.verificationCode = null;
            if (this.entity.verificationCode)
            {
                delete this.entity.verificationCode;
            }
             */
        }
        else
        {
            // If we're setting verified to false, generate a new verification code...
            //
            this.verificationCode = uuid.v4();
            this.entity.verificationCode = entGen.String(this.verificationCode);
        }
    }
    
    User.prototype.setLicenseAgreed = function(name, title, organization, version)
    {
        // licenseAgreed - Composed, read only (based on whether licenseAgreedDate is set)
        // licenseAgreedDate
        // licenseAgreedName
        // licenseAgreedTitle
        // licenseAgreedOrganization
        // licenseAgreedVersion
        
        this.licenseAgreed = true;
        this.licenseAgreedDate = new Date();
        this.licenseAgreedName = name;
        this.licenseAgreedTitle = title;
        this.licenseAgreedOrganization = organization;
        this.licenseAgreedVersion = version;
        
        this.entity.licenseAgreedDate = entGen.DateTime(this.licenseAgreedDate);
        this.entity.licenseAgreedName = entGen.String(this.licenseAgreedName);
        this.entity.licenseAgreedTitle = entGen.String(this.licenseAgreedTitle);
        this.entity.licenseAgreedOrganization = entGen.String(this.licenseAgreedOrganization);
        this.entity.licenseAgreedVersion = entGen.String(this.licenseAgreedVersion);
    }

    User.prototype.generateRecoveryCode = function()
    {
        this.recoveryCode = uuid.v4();
        this.recoveryCodeIssued = new Date();
        this.entity.recoveryCode = entGen.String(this.recoveryCode);
        this.entity.recoveryCodeIssued = entGen.DateTime(this.recoveryCodeIssued);

        return this.recoveryCode;
    }
    
    User.prototype.clearRecoveryCode = function()
    {
        this.recoveryCode = null;
        this.recoveryCodeIssued = null;
        if (this.entity.recoveryCode)
        {
            delete this.entity.recoveryCode;
        }
        if (this.entity.recoveryCodeIssued)
        {
            delete this.entity.recoveryCodeIssued;
        }
    }
    
    User.prototype.update = function (callback)
    {
        // Update the entity (properties that might have been changed directly by consumer of User)
        //
        this.entity.email = entGen.String(this.email);
        this.entity.name = entGen.String(this.name);
        this.entity.organization = entGen.String(this.organization);

        // Do the update...
        tableService.updateEntity(tableName, this.entity, function (error, entity, response)
        {
            if (!error)
            {
                logger.debug("Azure updateUser - table entity updated");
                this.entity = entity;
                callback(null);
            }
            else
            {
                logger.error("Azure updateUser - table entity update failed: " + error);
                callback(error);
            }
        });
    };
    
    // !!! Need to poll periodically to look for accounts that have not been verified within an
    //     interval of their creation (perhaps 1 day) so that we can cull them.
    //

    var userModel = 
    {
        createUser: function (newUser, callback)
        {
            // newUser { name, organization, email, password }
            //
            var entGen = azure.TableUtilities.entityGenerator;
            var user = {
                PartitionKey: entGen.String(partitionKey),
                RowKey: entGen.String(uuid.v4()),
                email: entGen.String(newUser.email),
                name: entGen.String(newUser.name),
                organization: entGen.String(newUser.organization),
                passwordHash: entGen.String(bcrypt.hashSync(newUser.password)),
                secret: entGen.String(uuid.v4()),
                verificationCode: entGen.String(uuid.v4()),
                verified: entGen.Boolean(false),
                accountCreationDate: entGen.DateTime(new Date())
            };
            
            tableService.insertEntity(tableName, user, { echoContent: true }, function (error, entity, response)
            {
                if (!error)
                {
                    logger.info("Azure createUser - table entity inserted");
                    callback(null, new User(entity));
                }
                else
                {
                    logger.error("Azure createUser - table entity insertion failed:", error);
                    callback(error);
                }
            });
        },
        
        getUser: function (userid, callback) // user if exists, else null
        {
            tableService.retrieveEntity(tableName, partitionKey, userid, function (error, entity, response)
            {
                if (!error)
                {
                    logger.debug("Azure getUser - table entity retrieved");
                    callback(null, new User(entity));
                }
                else if (error.code === "ResourceNotFound")
                {
                    logger.debug("Azure getUser - table entity not found");
                    callback(null, null);
                }
                else
                {
                    logger.error("Azure getUser - table entity retrieval failed:", error);
                    callback(error);
                }
            });
        },
        
        deleteUser: function (userid, callback) // bool
        {
            var entity = {
                PartitionKey: entGen.String(partitionKey),
                RowKey: entGen.String(userid)
            }

            tableService.deleteEntity(tableName, entity, function (error, successful, response)
            {
                if (!error)
                {
                    logger.info("Azure deleteUser - table entity deleted");
                    callback(null, true);
                }
                else
                {
                    logger.info("Azure deleteUser - table entity delete failed:", error);
                    callback(error);
                }
            });
        },

        getUserForKey: function (key, value, callback)
        {
            var query = new azure.TableQuery().top(1).where(key + ' eq ?', value);
            tableService.queryEntities(tableName, query, null, function (error, result, response)
            {
                if (!error)
                {
                    if (result.entries && result.entries.length > 0)
                    {
                        logger.debug("Azure getUserForKey - table entity retrieved");
                        var user = new User(result.entries[0]);
                        callback(null, user);
                    }
                    else
                    {
                        logger.debug("Azure getUserForKey - no matching table entity found");
                        callback(null);
                    }
                }
                else
                {
                    logger.error("Azure getUserForKey - failed:", error);
                    callback(error);
                }
            });
        },
    }

    return userModel;
}


