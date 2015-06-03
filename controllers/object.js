var express = require('express');
var router = express.Router();
var Models = require('octopus-models-api');
var sizeof = require('object-sizeof');
var security = require('./security');

router.use(security.keyValidation);

/**
 * Middleware used to load application model schema
 */
router.use(function(req, res, next) {
	//roughly 67M - it self cleares so it doesn't get too big
	if (sizeof(Models.Application.loadedAppModels) > (1 << 26)) {
		delete Models.Application.loadedAppModels;
		Models.Application.loadedAppModels = {};
	}

	if (!Models.Application.loadedAppModels[req._telepat.application_id]) {
		Models.Application.loadAppModels(req._telepat.application_id, next);
	} else
		next();
});

router.use(['/subscribe', '/unsubscribe'], security.objectACL('read_acl'));
router.use(['/create', '/update', '/delete'], security.objectACL('write_acl'));
router.use(['/count'], security.objectACL('meta_read_acl'));

/**
 * @api {post} /object/subscribe Subscribe
 * @apiDescription Subscribe to an object or a collection of objects (by a filter)
 * @apiName ObjectSubscribe
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {Number} id ID of the object (optional)
 * @apiParam {Number} context Context of the object
 * @apiParam {String} model The type of object to subscribe to
 * @apiParam {Object} filters Author or parent model filters by ID.
 *
 * @apiExample {json} Client Request
 * {
 * 		"id": 1,
 * 		"context": 1,
 * 		"model": "comment",
 *		"filters": {
 *			"user": 2,
 *			"event_id": 1,
 *			"query": {
 *				"or": [
 *					{
 *					  "and": [
 *						{
 *						  "is": {
 *							"gender": "male",
 *							"age": 23
 *						  }
 *						},
 *						{
 *						  "range": {
 *							"experience": {
 *							  "gte": 1,
 *							  "lte": 6
 *							}
 *						  }
 *						}
 *					  ]
 *					},
 *					{
 *					  "and": [
 *						{
 *						  "like": {
 *							"image_url": "png",
 *							"website": "png"
 *						  }
 *						}
 *					  ]
 *					}
 *				  ]
 *			}
 *		}
 * }
 *
 *	@apiSuccessExample {json} Success Response
 * 	{
 * 		"1": {
 * 			//item properties
 * 		}
 * 	}
 *
 * @apiError 402 NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError 404 NotFound If <code>id</code> was supplied but object not found or device is not registered.
 * @apiError 400 RequestedContextMissing If context id has been provided
 */
router.post('/subscribe', function(req, res, next) {
	var id = req.body.id;
	var context = req.body.context;
	var deviceId = req._telepat.device_id;
	var userEmail = req.user.email;
	var mdl = req.body.model;
	var appId = req._telepat.application_id;
	var elasticQuery = false;
	var elasticQueryResult = null;

	var filters = req.body.filters;

	if (!context)
		res.status(400).json({status: 400, message: "Requested context is not provided."}).end();
	//ia-le pe toate
	else {
		var objectCount = 0;

		async.waterfall([
			//see if device exists
			function(callback) {
				Models.Subscription.getDevice(deviceId, function(err, results) {
					if (err) {
						if (err.code == 13) {
							var error = new Error('Device is not registered');
							error.status = 404;
							return callback(error);
						} else
							return callback(err, null);
					}

					callback(null, results);
				});
			},
			//finally, add subscription
			function(result, callback) {
				var parent = {};
				var user = null;
				if (filters && filters.parent) {
					parent.model = Models.Application.loadedAppModels[appId][filters.parent.name].namespace;
					parent.id = filters.parent.id;
				}
				if (filters && filters.user)
					user = filters.user;

				Models.Subscription.add(appId, context, deviceId, {model: Models.Application.loadedAppModels[appId][mdl].namespace, id: id}, user, parent, filters.query,  callback);
			},
			function(result, callback) {
				if(!id) {
					if (filters) {
						if (filters.query) {
							elasticQuery = true;
							var elasticSearchQuery = {
								query: {
									filtered: {
										query: {
											bool: {
												must: [
													{term: {'doc.type': mdl}},
													{term: {'doc.context_id': context}}
												]
											}
										}
									}
								}
							};

							elasticSearchQuery.query.filtered.filter = Models.utils.parseQueryObject(filters.query);
							app.get('elastic-db').client.search({
								index: 'default',
								type: 'couchbaseDocument',
								body: elasticSearchQuery
							}, function(err, result) {
								if (err) return callback(err);
								objectCount = result.hits.total;
								elasticQueryResult = result.hits.hits;
							});

						} else {
							for (var rel in Models.Application.loadedAppModels[appId][mdl].belongsTo) {
								var parentModelId = filters[Models.Application.loadedAppModels[appId][mdl].belongsTo[rel].parentModel+'_id'];
								if (parentModelId !== undefined) {
									var parentModel = Models.Application.loadedAppModels[appId][mdl].belongsTo[rel].parentModel;

									Models.Model.lookup(mdl, appId, context, filters.user, {model: parentModel, id: parentModelId}, function(err, results) {
										if (!results) {
											callback(err, results);
										} else {
											objectCount = results.length;
											results = results.slice(0, 10);

											Models.Model.multiGet(mdl, results, appId, context, callback);
										}
									});
								}
							}
						}

					} else {
						Models.Model.getAll(mdl, appId, context, function(err, results) {
							callback(err, results);
						});
					}
				} else {
					new Models.Model(mdl, appId, id, context, function(err, results) {
						if (err) return callback(err, null);

						var message = {};
						message[id] = results.value;
						objectCount = 1;

						callback(null, message)
					});
				}
			},
			function(results, callback) {
				app.kafkaProducer.send([{
					topic: 'track',
					messages: [JSON.stringify({
						op: 'sub',
						object: {id: id, context: context, device_id: deviceId, user_id: userEmail, filters: filters},
						applicationId: appId
					})],
					attributes: 0
				}], function(err, data) {
					if (err) return callback(err, null);

					callback(err, results);
				});
			},
			function(results, callback) {
				Subscription.setObjectCount(appId, context, {model: mdl, id: id}, filters.user, filters.parent, filters.query, objectCount, function(err, result) {
					callback(err, results);
				});
			}
		], function(err, result) {
			if (err)
				return next(err);

			if(elasticQuery) {
				result = {};
				async.each(elasticQueryResult.applicationId.hits.hits, function(item, c) {
					result[item._source.doc.id] = item._source.doc;
					c();
				}, function(err) {
					res.json({status: 200, message: result}).end();
				});
			} else {
				res.json({status: 200, message: result}).end();
			}
		});
	}
});

/**
 * @api {post} /object/unsubscribe Unsubscribe
 * @apiDescription Unsubscribe to an object or a collection of objects (by a filter)
 * @apiName ObjectUnsubscribe
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {Number} id ID of the object (optional)
 * @apiParam {Number} context Context of the object
 * @apiParam {String} model The type of object to subscribe to
 * @apiParam {Object} filters Author or parent model filters by ID.
 *
 * @apiExample {json} Client Request
 * {
 * 		//exactly the same as with the subscribe method
 * }
 *
 * @apiSuccessExample {json} Success Response
 * 	{
 * 		"status": 200,
 * 		"message": "Subscription removed"
 * 	}
 *
 * @apiError 402 NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError 404 NotFound If subscription doesn't exist.
 */
router.post('/unsubscribe', function(req, res, next) {
	var id = req.body.id;
	var context = req.body.context;
	var deviceId = req._telepat.device_id;
	var filters = req.body.filters;
	var mdl = req.body.model;
	var appId = req._telepat.application_id;

	if (!context)
		res.status(400).json({status: 400, message: "Requested context is not provided."}).end();
	else {
		async.waterfall([
			function(callback) {
				Models.Subscription.remove(context, deviceId, {model: Models.Application.loadedAppModels[appId][mdl].namespace, id: id}, filters, function(err, results) {
					if (err && err.code == cb.errors.keyNotFound) {
						var error = new Error('Subscription not found');
						error.status = 404;

						callback(error, null);
					}	else if (err)
						callback(err, null);
					else
						callback(null, {status: 200, message: "Subscription removed"});
				});
			},
			function(result, callback) {
				app.kafkaProducer.send([{
					topic: 'track',
					messages: [JSON.stringify({
						op: 'unsub',
						object: {id: id, context: context, device_id: deviceId, filters: filters},
						applicationId: appId
					})],
					attributes: 0
				}], function(err, data) {
					if (err) return callback(err, null);

					callback(err, result);
				});
			}
		], function(err, results) {
			if (err) return next(err);

			res.status(results.status).json(results).end();
		});
	}
});

/**
 * @api {post} /object/create Create
 * @apiDescription Creates a new object
 * @apiName ObjectCreate
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {String} model The type of object to subscribe to
 * @apiParam {Object} content Content of the object
 *
 * @apiExample {json} Client Request
 * {
 * 		"model": "comment",
 * 		"content": {
 *			//object properties
 * 		}
 * }
 *
 * @apiSuccessExample {json} Success Response
 * 	{
 * 		"status": 201,
 * 		"message": "Created"
 * 	}
 *
 * @apiError NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError NotFound If <code>id</code> was supplied but object not found.
 * @apiError PermissionDenied If the model requires other permissions other than the ones provided.
 */
router.post('/create', function(req, res, next) {
	var content = req.body.content;
	var mdl = req.body.model;
	var appId = req._telepat.application_id;
	var isAdmin = false;

	content.type = mdl;
	content.context_id = req.body.context;

	if (Models.Application.loadedAppModels[appId][mdl].belongs_to) {
		var parentModel = Models.Application.loadedAppModels[appId][mdl].belongs_to[0].parentModel;
		if (!content[parentModel+'_id']) {
			var error = new Error("'"+parentModel+"_id' is required");
			error.status = 400;

			return next(error);
		}
	}

	async.series([
		function(callback) {
			if (req.user.isAdmin) {
				Models.Admin(req.user.email, function(err, result) {
					if (err) return callback(err);
					content.user_id = result.id;
					isAdmin = true;
					callback();
				});
			} else {
				Models.User(req.user.email, function(err, result) {
					if (err) return callback(err);
					content.user_id = result.id;
					callback();
				});
			}
		},
		function(agg_callback) {
			app.kafkaProducer.send([{
				topic: 'aggregation',
				messages: [JSON.stringify({
					op: 'add',
					object: content,
					applicationId: appId,
					isAdmin: isAdmin
				})],
				attributes: 0
			}], function(err) {
				err.message = 'Failed to send message to aggregation worker.';
				agg_callback(err);
			});
		},
		function(track_callback) {
			app.kafkaProducer.send([{
				topic: 'track',
				messages: [JSON.stringify({
					op: 'add',
					object: content,
					applicationId: appId,
					isAdmin: isAdmin
				})],
				attributes: 0
			}], function(err) {
				err.message = 'Failed to send message to track worker.';
				track_callback();
			});
		}
	], function(err, results) {
		if (err) {
			console.log(req.originalUrl+': '+err.message.red);
			return next(err);
		}

		res.status(201).json({status: 201, message: 'Created'}).end();
	});
});

/**
 * @api {post} /object/update Update
 * @apiDescription Updates an existing object
 * @apiName ObjectUpdate
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {Number} id ID of the object (optional)
 * @apiParam {Number} context Context of the object
 * @apiParam {String} model The type of object to subscribe to
 * @apiParam {Array} patch An array of patches that modifies the object
 *
 * @apiExample {json} Client Request
 * {
 * 		"model": "comment",
 * 		"id": 1,
 * 		"context": 1,
 * 		"patch": [
 * 			{
 * 				"op": "replace",
 * 				"path": "text",
 * 				"value": "some edited text"
 * 			},
 * 			...
 * 		],
 * }
 *
 * @apiSuccessExample {json} Success Response
 * 	{
 * 		"status": 201,
 * 		"message": "Created"
 * 	}
 *
 * @apiError NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError NotFound If <code>id</code> was supplied but object not found.
 * @apiError PermissionDenied If the model requires other permissions other than the ones provided.
 */
router.post('/update', function(req, res, next) {
	var context = req.body.context;
	var patch = req.body.patch;
	var id = req.body.id;
	var mdl = req.body.model;
	var appId = req._telepat.application_id;

	if (! (patch instanceof Array)) {
		var error = new Error('Patch must be an array');
		error.status = 400;

		return next(error);
	}

	async.series([
		function(agg_callback) {
			app.kafkaProducer.send([{
				topic: 'aggregation',
				messages: [JSON.stringify({
					op: 'edit',
					id: id,
					context: context,
					object: patch,
					type: mdl,
					applicationId: appId
				})],
				attributes: 0
			}], function(err) {
				err.message = 'Failed to send message to aggregation worker.';
				agg_callback(err);
			});
		},
		function(track_callback) {
			app.kafkaProducer.send([{
				topic: 'track',
				messages: [JSON.stringify({
					op: 'edit',
					id: id,
					context: context,
					object: patch,
					type: mdl,
					applicationId: appId
				})],
				attributes: 0
			}], function(err) {
				err.message = 'Failed to send message to track worker.';
				track_callback();
			});
		}
	], function(err, results) {
		if (err) {
			console.log(req.originalUrl+': '+err.message.red);
			return next(err);
		}

		res.status(200).json({status: 200, message: 'Updated'}).end();
	});
});

/**
 * @api {post} /object/delete Delete
 * @apiDescription Deletes an object
 * @apiName ObjectDelete
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {Number} id ID of the object (optional)
 * @apiParam {Number} context Context of the object
 * @apiParam {String} model The type of object to delete
 *
 * @apiExample {json} Client Request
 * {
 * 		"model": "comment",
 * 		"id": 1,
 * 		"context": 1
 * }
 *
 * @apiError NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError NotFound If <code>id</code> was supplied but object not found.
 * @apiError PermissionDenied If the model requires other permissions other than the ones provided.
 */
router.post('/delete', function(req, res, next) {
	var id = req.body.id;
	var context = req.body.context;
	var mdl = req.body.model;
	var appId = req._telepat.application_id;

	async.series([
		function(agg_callback) {
			app.kafkaProducer.send([{
				topic: 'aggregation',
				messages: [JSON.stringify({
					op: 'delete',
					object: {id: id, type: mdl, context: context},
					applicationId: appId
				})],
				attributes: 0
			}], agg_callback);
		},
		function(track_callback) {
			app.kafkaProducer.send([{
				topic: 'track',
				messages: [JSON.stringify({
					op: 'delete',
					object: {op: 'remove', path: mdl+'/'+id},
					applicationId: appId
				})],
				attributes: 0
			}], track_callback);
		}
	], function(err, results) {
		if (err) return next(err);

		res.status(200).json({status: 200, message: 'Deleted'}).end();
	});
});

/**
 * @api {post} /object/count Count
 * @apiDescription Gets the object count of a certain filter/subscription
 * @apiName ObjectCount
 * @apiGroup Object
 * @apiVersion 0.0.1
 *
 * @apiParam {Number} context Context of the object
 * @apiParam {String} model The type of object to subscribe to
 * @apiParam {Object} channel asdsadas
 *
 * @apiError NotAuthenticated  Only authenticated users may access this endpoint.
 * @apiError NotFound If <code>id</code> was supplied but object not found.
 * @apiError PermissionDenied If the model requires other permissions other than the ones provided.
 */
router.post('/count', function(req, res, next) {
	var appId = req._telepat.application_id,
		context = req.body.context_id,
		channel = {model: req.body.model, id: req.body.id},
		user_id = req.user.id,
		parent = req.parent;

	Models.Subscription.getObjectCount(appId, context, channel, user_id, parent, function(err, result) {
		if (err) return next(err);

		res.status(200).json({status: 200, message: result}).end();
	});
});

module.exports = router;
