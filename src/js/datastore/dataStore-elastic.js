/**
 * ElasticSearch based implementation of the data store.
 */

var textChunkSize = 1000;

var fs = require('fs');
var wikitext = require("../import/wikitext-parser.js");

var buildRangeQuery = function(textId, start, end) {
	return {
		"query" : {
			"bool" : {
				"must" : [ {
					"text" : {
						"textid" : textId
					}
				}, {
					"range" : {
						"start" : {
							"lt" : end
						}
					}
				}, {
					"range" : {
						"end" : {
							"gte" : start
						}
					}
				} ]
			}
		},
		"size" : 10000
	};
};

/**
 * Accepts blocks of input text ordered by sequence and emits an array of {offset, text} where the
 * text parts are split on spaces and are at most maxSize characters long.
 */
var createTextChunks = function(maxSize, data) {
	/* Sort by sequence, extract text parts and join together */
	var text = data.text.sort(function(a, b) {
		return a.sequence - b.sequence;
	}).map(function(struct) {
		return struct.text;
	}).join("");
	var result = [];
	var offset = 0;
	while (text != "") {
		var length = text.lastIndexOf(" ", maxSize);
		if (length == -1) {
			length = text.length;
		} else if (length == 0) {
			result.push({
				text : text,
				offset : offset
			});
			text = "";
		} else {
			result.push({
				text : text.substring(0, length),
				offset : offset
			});
			text = text.substring(length);
			offset += length;
		}

	}
	console.log("Chunked text - " + result.length + " parts.");
	return result;
};

/**
 * Accept a start and end offset and a set of text chunks which guarantee to cover the specified
 * range, and return {text:STRING, start:INT, end:INT} for that range.
 */
var joinTextChunksAndTrim = function(start, end, chunks) {
	if (chunks.length == 0) {
		return {
			text : "",
			start : 0,
			end : 0
		};
	}
	chunks.sort(function(a, b) {
		return a.start - b.start;
	});
	return {
		text : chunks.map(function(chunk) {
			return chunk.text;
		}).join("").substr(start - chunks[0].start, end - start),
		start : start,
		end : end
	};
};

module.exports = exports = function(conf) {

	var elastical = require('elastical');
	var client = new elastical.Client(conf.es.host, {
		port : conf.es.port,
		protocol : conf.es.protocol,
		timeout : conf.es.timeout
	});

	var indexArray = function(index, type, list, callback) {
		var item = list.shift();
		if (item) {
			client.index(index, type, item, function(err, res) {
				if (err) {
					console.log(err);
					callback(err);
				} else {
					indexArray(index, type, list, callback);
				}
			});
		} else {
			console.log("Indexed data with type " + type);
			callback(null);
		}
	};

	var indexArrays = function(index, lists, callback) {
		var wrap = lists.shift();
		if (wrap) {
			var type = wrap.type;
			var list = wrap.list;
			indexArray(index, type, list, function(err) {
				if (err) {
					err.message = "Error while indexing " + type;
					callback(err);
				} else {
					indexArrays(index, lists, callback);
				}
			});
		} else {
			callback(null);
		}
	};

	var datastore = {

		/**
		 * Load data from the specified file path, interpreting it as wikitext markup.
		 * 
		 * @param path
		 *            the file path of the file to import
		 * @param title
		 *            the title to assign the file as the top level structural annotation
		 * @param description
		 *            the description for the top level annotation
		 * @param callback
		 *            a callback, called with (err, result) where the result is the textID of the
		 *            new text, and err is null unless something went wrong.
		 * @returns
		 */
		loadFromWikiTextFile : function(path, title, description, callback) {
			fs.readFile(path, 'utf8', function(error, data) {
				// File read into 'data' as a string
				if (error) {
					console.log(path);
					callback(error, null);
					return;
				} else {
					if (data == "" || data == null) {
						callback("No data provided", null);
						return;
					}
					var parsed = wikitext.readWikiText(data);
					var result = {
						text : [ {
							text : parsed.text,
							sequence : 0
						} ],
						typography : parsed.typography,
						semantics : [],
						structure : [ {
							type : "textus:document",
							start : 0,
							depth : 0,
							description : description,
							name : title
						} ]
					};
					datastore.importData(result, function(err, textId) {
						if (err) {
							console.log("Import to data store failed : " + err);
							callback(err, null);
						} else {
							console.log("Imported text with text ID : " + textId);
							callback(null, textId);
						}
					});
				}
			});
		},

		/**
		 * Retrieve a user record by user ID, typically an email address
		 * 
		 * @param userId
		 *            the user ID to retrieve
		 * @param callback
		 *            a function(err, user) called with the user structure or an error if no such
		 *            user exists
		 */
		getUser : function(userId, callback) {
			client.get("textus-users", userId, {
				type : "user"
			}, function(err, user) {
				callback(err, user);
			});
		},

		/**
		 * Create a new user, passing in a description of the user to create and calling the
		 * specified callback on success or failure
		 * 
		 * @param user
		 *            a user structure, see
		 * @param callback
		 *            a function(error, user) called with the user object stored or an error if the
		 *            storage was unsuccessful.
		 */
		createUser : function(user, callback) {
			client.index("textus-users", "user", user, {
				id : user.id,
				refresh : true,
				create : true
			}, function(err, result) {
				if (err) {
					callback(err, null);
				} else {
					callback(null, user);
				}
			});
		},

		/**
		 * As with create, but will not fail if the user already exists
		 */
		createOrUpdateUser : function(user, callback) {
			cliend.index("textus-users", "user", user, {
				id : user.id,
				refresh : true,
				create : false
			}, function(err, result) {
				if (err) {
					callback(err, null);
				} else {
					callback(null, user);
				}
			});
		},

		/**
		 * Delete the specified user record
		 */
		deleteUser : function(userId, callback) {
			client.delete("textus-users", "user", userId, function(err, result) {
				if (err) {
					callback(err, null);
				} else {
					callback(null, result);
				}
			});
		},

		/**
		 * Create and index a new semantic annotation
		 * 
		 * @param annotation
		 * @param callback
		 * @returns
		 */
		createSemanticAnnotation : function(annotation, callback) {
			client.index("textus", "semantics", annotation, {
				refresh : true
			}, function(err, response) {
				if (err) {
					console.log(err);
				} else {
					//
				}
				callback(err, response);
			});
		},

		/**
		 * Returns all text structure records in the database in the form { textid : STRING,
		 * structure : [] } via the callback(error, data).
		 */
		getTextStructures : function(callback) {
			var query = {
				"query" : {
					"match_all" : {}
				},
				"filter" : {
					"type" : {
						"value" : "structure"
					}
				},
				"size" : 10000
			};
			client.search(query, function(err, results, res) {
				if (err) {
					callback(err, null);
				} else {
					callback(null, results.hits.map(function(hit) {
						return {
							textid : hit._id,
							structure : hit._source.structure
						};
					}));
				}
			});
		},

		/**
		 * Retrieves text along with the associated typographical and semantic annotations which
		 * overlap at least partially with the specified range.
		 * 
		 * @param textId
		 *            the TextID of the text
		 * @param start
		 *            character offset within the text, this will be the first character in the
		 *            result
		 * @param end
		 *            character offset within the text, this will be the character one beyond the
		 *            end of the result, so the result is a string of end-start length
		 * @param callback
		 *            a callback function callback(err, data) called with the data from the
		 *            elasticsearch query massaged into the form { textid : STRING, text : STRING,
		 *            typography : [], semantics : [], start : INT, end : INT }, and the err value
		 *            set to any error (or null if no error) from the underlying elasticsearch
		 *            instance.
		 * @returns
		 */
		fetchText : function(textId, start, end, callback) {
			client.search(buildRangeQuery(textId, start, end), function(err, results, res) {
				if (err) {
					callback(err, null);
				} else {
					var textChunks = [];
					var typography = [];
					var semantics = [];
					var error = null;
					results.hits.forEach(function(hit) {
						if (hit._type == "text") {
							textChunks.push(hit._source);
						} else if (hit._type == "typography") {
							hit._source.id = hit._id;
							typography.push(hit._source);
						} else if (hit._type == "semantics") {
							hit._source.id = hit._id;
							semantics.push(hit._source);
						} else {
							error = "Unknown result type! '" + hit._type + "'.";
							console.log(hit);
						}
					});
					callback(error, {
						textid : textId,
						text : joinTextChunksAndTrim(start, end, textChunks).text,
						typography : typography,
						semantics : semantics,
						start : start,
						end : end
					});
				}
			});
		},

		/**
		 * Index the given data, calling the callback function on completion with either an error
		 * message or the text ID of the stored data.
		 * 
		 * @param data {
		 *            text : [ { text : STRING, sequence : INT } ... ], semantics : [], typography :
		 *            [], structure : [] }
		 * @param callback
		 *            a function of type function(error, textID)
		 * @returns immediately, asynchronous function.
		 */
		importData : function(data, callback) {
			var indexName = "textus";
			client.index(indexName, "structure", {
				time : Date.now(),
				structure : data.structure
			}, function(err, res) {
				if (!err) {
					var textId = res._id;
					console.log("Registered structure, textID set to " + textId);
					var dataToIndex = [ {
						type : "text",
						list : createTextChunks(textChunkSize, data).map(function(chunk) {
							return {
								textid : textId,
								text : chunk.text,
								start : chunk.offset,
								end : chunk.offset + chunk.text.length
							};
						})
					}, {
						type : "semantics",
						list : data.semantics.map(function(annotation) {
							annotation.textid = textId;
							return annotation;
						})
					}, {
						type : "typography",
						list : data.typography.map(function(annotation) {
							annotation.textid = textId;
							return annotation;
						})
					} ];
					indexArrays(indexName, dataToIndex, function(err) {
						callback(err, textId);
					});
				} else {
					callback(err, null);
				}
			});
		}
	};

	return datastore;

};
