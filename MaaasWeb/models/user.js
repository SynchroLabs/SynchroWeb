var bcrypt = require('bcryptjs');
var uuid = require('node-uuid');
var azure = require('azure-storage');
var entGen = azure.TableUtilities.entityGenerator;

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
            console.log("Azure webuser table created or already existed");
        }
        else
        {
            console.log("Azure webuser table did not exist and could not be created: " + error);
        }
    });
    
    function User(entity)
    {
        this.entity = entity;
        this.email = entity.RowKey._;
        this.passwordHash = entity.passwordHash._;
        this.secret = entity.secret._;
        this.verificationCode = entity.verificationCode ? entity.verificationCode._ : null;
        this.verified = entity.verified._;
        this.recoveryCode = entity.recoveryCode ? entity.recoveryCode._ : null;
        this.recoveryCodeIssued = entity.recoveryCodeIssued ? entity.recoveryCodeIssued._ : null;
    }
    
    User.prototype.setPassword = function (password)
    {
        this.passwordHash = bcrypt.hashSync(password);
    }    

    User.prototype.isPasswordValid = function (password)
    {
        return bcrypt.compareSync(password, this.passwordHash);
    }
    
    User.prototype.setVerified = function()
    {
        this.verified = true;
        this.verificationCode = null
        if (this.entity.verificationCode)
        {
            delete this.entity.verificationCode;
        }
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
        // Update the entity (from members that might have been changed directly by consumer of User)
        this.entity.passwordHash = entGen.String(this.passwordHash);
        this.entity.verified = entGen.Boolean(this.verified);

        // Do the update...
        tableService.updateEntity(tableName, this.entity, function (error, entity, response)
        {
            if (!error)
            {
                console.log("Azure updateUser - table entity updated");
                this.entity = entity;
                callback(null);
            }
            else
            {
                console.log("Azure updateUser - table entity update failed: " + error);
                callback(error);
            }
        });
    };
    
    var userModel = 
    {
        createUser: function (email, password, callback)
        {
            // user
            var entGen = azure.TableUtilities.entityGenerator;
            var user = {
                PartitionKey: entGen.String(partitionKey),
                RowKey: entGen.String(email),
                passwordHash: entGen.String(bcrypt.hashSync(password)),
                secret: entGen.String(uuid.v4()),
                verificationCode: entGen.String(uuid.v4()),
                verified: entGen.Boolean(false),
                accountCreationDate: entGen.DateTime(new Date())
            };
            
            tableService.insertEntity(tableName, user, { echoContent: true }, function (error, entity, response)
            {
                if (!error)
                {
                    console.log("Azure createUser - table entity inserted");
                    callback(null, new User(entity));
                }
                else
                {
                    console.log("Azure createUser - table entity insertion failed: " + error);
                    callback(error);
                }
            });
        },
        
        getUser: function (email, callback) // user if exists, else null
        {
            tableService.retrieveEntity(tableName, partitionKey, email, function (error, entity, response)
            {
                if (!error)
                {
                    console.log("Azure getUser - table entity retrieved");
                    callback(null, new User(entity));
                }
                else if (error.code === "ResourceNotFound")
                {
                    console.log("Azure getUser - table entity not found");
                    callback(null, null);
                }
                else
                {
                    console.log("Azure getUser - table entity retrieval failed: " + error);
                    callback(error);
                }
            });
        },
        
        deleteUser: function (email, callback) // bool
        {
            var entity = {
                PartitionKey: entGen.String(partitionKey),
                RowKey: entGen.String(email)
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
                    logger.info("Azure deleteUser - table entity delete failed: " + error);
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
                        console.log("Azure getUserForKey - table entity retrieved");
                        var user = new User(result.entries[0]);
                        callback(null, user);
                    }
                    else
                    {
                        console.log("Azure getUserForKey - no matching table entity found");
                        callback(null);
                    }
                }
                else
                {
                    logger.info("Azure getUserForKey - failed: " + error);
                    callback(error);
                }
            });
        },
    }

    return userModel;
}


