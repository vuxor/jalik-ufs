if (Meteor.isServer) {
    domain = Npm.require('domain');
    fs = Npm.require('fs');
    Future = Npm.require('fibers/future');
    mkdirp = Npm.require('mkdirp');
    stream = Npm.require('stream');
    zlib = Npm.require('zlib');


    // Create the temporary upload dir
    Meteor.startup(function () {
        createTempDir();
    });

    Meteor.methods({
        /**
         * Completes the file transfer
         * @param fileId
         * @param storeName
         */
        ufsComplete: function (fileId, storeName) {
            check(fileId, String);
            check(storeName, String);

            var store = UploadFS.getStore(storeName);

            // Check arguments
            if (!store) {
                throw new Meteor.Error(404, 'store "' + storeName + '" does not exist');
            }

            // Check that file exists and is owned by current user
            if (store.getCollection().find({_id: fileId, userId: this.userId}).count() < 1) {
                throw new Meteor.Error(404, 'file "' + fileId + '" does not exist');
            }

            var fut = new Future();
            var tmpFile = UploadFS.getTempFilePath(fileId);

            // Get the temporary file
            var readStream = fs.createReadStream(tmpFile, {
                flags: 'r',
                encoding: null,
                autoClose: true
            });

            // Save the file in the store
            store.write(readStream, fileId, function (err, file) {
                if (err) {
                    // Delete the temporary file
                    Meteor.setTimeout(function () {
                        fs.unlink(tmpFile);
                    }, 500);
                    fut.throw(err);
                } else {
                    fut.return(file);
                    fs.unlink(tmpFile);
                }
            });

            return fut.wait();
        },

        /**
         * Saves a chunk of file
         * @param chunk
         * @param fileId
         * @param storeName
         * @return {*}
         */
        ufsWrite: function (chunk, fileId, storeName) {
            check(fileId, String);
            check(storeName, String);

            // Check arguments
            if (!(chunk instanceof Uint8Array)) {
                throw new Meteor.Error(400, 'chunk is not an Uint8Array');
            }
            if (chunk.length <= 0) {
                throw new Meteor.Error(400, 'chunk is empty');
            }

            var store = UploadFS.getStore(storeName);
            if (!store) {
                throw new Meteor.Error(404, 'store ' + storeName + ' does not exist');
            }

            // Check that file exists, is not complete and is owned by current user
            if (store.getCollection().find({_id: fileId, complete: false, userId: this.userId}).count() < 1) {
                throw new Meteor.Error(404, 'file ' + fileId + ' does not exist');
            }

            var fut = new Future();
            var tmpFile = UploadFS.getTempFilePath(fileId);
            fs.appendFile(tmpFile, new Buffer(chunk), function (err) {
                if (err) {
                    console.error(err);
                    fs.unlink(tmpFile);
                    fut.throw(err);
                } else {
                    fut.return(chunk.length);
                }
            });
            return fut.wait();
        }
    });

    // Create domain to handle errors
    // and possibly avoid server crashes.
    var d = domain.create();

    d.on('error', function (err) {
        console.error(err);
    });

    // Listen HTTP requests to serve files
    WebApp.connectHandlers.use(function (req, res, next) {
        // Quick check to see if request should be catch
        if (req.url.indexOf(UploadFS.config.storesPath) === -1) {
            next();
            return;
        }

        // Remove store path
        var path = req.url.substr(UploadFS.config.storesPath.length + 1);

        // Get store and file
        var regExp = new RegExp('^\/([^\/]+)\/([^\/]+)$');
        var match = regExp.exec(path);

        if (match !== null) {
            // Get store
            var storeName = match[1];
            var store = UploadFS.getStore(storeName);
            if (!store) {
                res.writeHead(404, {});
                res.end();
                return;
            }

            // Simulate read speed
            if (UploadFS.config.simulateReadDelay) {
                Meteor._sleepForMs(UploadFS.config.simulateReadDelay);
            }

            // Get file from database
            var fileId = match[2].replace(/\.[^.]+$/, '');
            var file = store.getCollection().findOne(fileId);
            if (!file) {
                res.writeHead(404, {});
                res.end();
                return;
            }

            // Execute callback to do some check (eg. security check)
            if (typeof store.onRead === 'function') {
                store.onRead.call(store, fileId, file, req, res);
            }

            d.run(function () {
                var accept = req.headers['accept-encoding'] || '';
                var rs = store.getReadStream(fileId, file);
                var ws = new stream.PassThrough();
                var headers = {
                    'Content-Type': file.type,
                    'Content-Length': file.size
                };

                // Catch read errors
                rs.on('error', function (err) {
                    console.error(err);
                });

                // Catch write errors
                ws.on('error', function (err) {
                    console.error(err);
                });

                // Force ending of stream
                ws.on('close', function () {
                    //console.log('CLOSE');
                    ws.emit('end');
                });

                // Transform stream
                store.transformRead(rs, ws, fileId, file, req, headers);

                // Compress data using gzip
                if (accept.match(/\bgzip\b/)) {
                    //console.log("GZIP")
                    headers['Content-Encoding'] = 'gzip';
                    delete headers['Content-Length'];
                    res.writeHead(200, headers);
                    ws.pipe(zlib.createGzip()).pipe(res);
                }
                // Compress data using deflate
                else if (accept.match(/\bdeflate\b/)) {
                    //console.log("DEFLATE")
                    headers['Content-Encoding'] = 'deflate';
                    delete headers['Content-Length'];
                    res.writeHead(200, headers);
                    ws.pipe(zlib.createDeflate()).pipe(res);
                }
                // Send data uncompressed
                else {
                    //console.log("RAW")
                    res.writeHead(200, headers);
                    ws.pipe(res);
                }
            });

        } else {
            next();
        }
    });

    function createTempDir() {
        var path = UploadFS.config.tmpDir;
        mkdirp(path, function (err) {
            if (err) {
                console.error('ufs: cannot create tmpDir ' + path);
            } else {
                console.log('ufs: created tmpDir ' + path);
            }
        });
    }
}
