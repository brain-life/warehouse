'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const winston = require('winston');
const async = require('async');
const request = require('request');

const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');
const common = require('../common');

function canedit(user, rec) {
    if(user) {
        if(user.scopes.warehouse && ~user.scopes.warehouse.indexOf('admin')) return true;
        if(rec.admins && ~rec.admins.indexOf(user.sub.toString())) return true;
    }
    return false;
}

/**
 * @apiGroup App
 * @api {get} /app              Query apps
 * @apiDescription              Query registered apps
 *
 * @apiParam {Object} [find]    Optional Mongo find query - defaults to {}
 * @apiParam {Object} [sort]    Optional Mongo sort object - defaults to {}
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {String} [populate] Relational fields to populate
 * @apiParam {Number} [limit]   Optional Maximum number of records to return
 * @apiParam {Number} [skip]    Optional Record offset for pagination
 *
 * @apiHeader {String} [authorization]
 *                              A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object}         List of apps (maybe limited / skipped) and total count
 */
router.get('/', jwt({secret: config.express.pubkey, credentialsRequired: false}), (req, res, next)=>{
    var skip = req.query.skip||0;
    let limit = req.query.limit||100;
    var ands = [];
    if(req.query.find) ands.push(JSON.parse(req.query.find));
    
    common.getprojects(req.user, (err, project_ids)=>{
        if(err) return next(err);
        ands.push({$or: [ 
            //if projects is set, user need to have access to it
            {projects: {$in: project_ids}},

            {projects: []}, //if projects is empty array, it's available to everyone

            //for backward compatibility
            {projects: null}, //if projects is set to null, it's avalable to everyoone
            {projects: {$exists: false}}, //if projects not set, it's availableo to everyone
        ]});

        db.Apps.find({$and: ands})
        .select(req.query.select)
        .limit(+limit)
        .skip(+skip)
        .sort(req.query.sort || '_id')
        .populate(req.query.populate || '')
        .lean()
        .exec((err, recs)=>{
            if(err) return next(err);
            db.Apps.count({$and: ands}).exec((err, count)=>{
                if(err) return next(err);
                //adding some derivatives
                if(req.user) recs.forEach(function(rec) {
                    rec._canedit = canedit(req.user, rec);
                });
                res.json({apps: recs, count: count});
            });
        });
    });

});

//experimental
router.get('/:id/badge', (req, res, next)=>{
    db.Apps.findById(req.params.id).select('stats').exec((err, app)=>{
        if(err) return next(err);
        if(!app) return next("no such app");
        /*
10|warehou | {
10|warehou |     "stats": {
10|warehou |         "stars": 1,
10|warehou |         "requested": 288,
10|warehou |         "users": 2,
10|warehou |         "success_rate": 83
10|warehou |     },
10|warehou |     "_id": "58c56d92e13a50849b258801"
10|warehou | }
        */
        res.redirect('https://img.shields.io/badge/Brainlife-'+app.stats.requested+' runs ('+app.stats.users+' users)-brightgreen.svg');
    });
});

/*
function mint_doi(cb) {
    db.Apps.count({doi: {$exists: true}}).exec((err, count)=>{
        if(err) return cb(err);
        cb(null, config.datacite.prefix+"app."+count);
    });
}
*/

/**
 * @apiGroup App
 * @api {post} /app             Post App
 * @apiDescription              Register new app (don't set id to null)
 *
 * @apiParam {String} [name]    User friendly name for this app
 * @apiParam {String} [desc]    Description for this app
 * @apiParam {String[]} [tags]  List of tags to classify this app
 * @apiParam {String} [avatar]  URL for application avatar
 * @apiParam {String} [github]  github id/name for this app
 * @apiParam {Number} [retry]   Number of time this app should be retried (0 by default)
 * @apiParam {Object[]} [inputs]    Input datatypes. Array of {id, datatype, datatype_tags[]}
 * @apiParam {Object[]} [outputs]   Output datatypes. same as input datatype
 * @apiParam {String[]} [projects]  List of project IDs that this app should be exposed in 
 *
 * @apiParam {String} [github]   Github org/name
 * @apiParam {String} [github_branch]   Github default branch/tag name
 *
 * @apiParam {Object} [config]   configuration template
 *
 * @apiParam {String} [dockerhub]   Dockerhub id/name
 *
 * @apiParam {String[]} admins  Admin IDs
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         App registered
 */
router.post('/', jwt({secret: config.express.pubkey}), (req, res, next)=>{

    req.body.user_id = req.user.sub;
    
    let app = new db.Apps(req.body);

    async.series([
        //access check
        cb=>{
            logger.debug("validating");
            common.validate_projects(req.user, req.body.projects, cb);
        },
        
        //update info from github
        cb=>{
            logger.debug("loading github info");
            common.pull_appinfo(app.github, (err, info)=>{
                if(err) return cb(err);
                Object.assign(app, info);
                cb();
            });
        },

        //mint doi
        cb=>{
            logger.debug("minting doi");
            common.get_next_app_doi((err, doi)=>{
                if(err) return cb(err);
                app.doi = doi;
                cb();
            });
        },

        //save app (and generate _id)
        cb=>{
            logger.debug("saving app");
            app.save((err, _app)=>{
                if(err) return cb(err);
                app = _app;
                cb();
            });
        },

        //store doi meta
        cb=>{
            logger.debug("posting metadata for doi");
            let metadata = common.compose_app_datacite_metadata(app);
            common.doi_post_metadata(metadata, err=>{
                if(err) return cb(err);
                //then attach url to it (to "mint" it!)
                let url = config.warehouse.url+"/app/"+app._id;  
                common.doi_put_url(app.doi, url, cb);
            });
        },
    ], err=>{
        if(err) return next(err);
        app = JSON.parse(JSON.stringify(app));
        app._canedit = canedit(req.user, app);
        res.json(app);
    });
});

/**
 * @apiGroup App
 * @api {put} /app/:id          Update App
 *                              
 * @apiDescription              Update App
 *
 * @apiParam {String} [name]    User friendly name for this container 
 * @apiParam {String} [desc]    Description for this dataset 
 * @apiParam {String[]} [tags]  List of tags to classify this app
 * @apiParam {String} [avatar]  URL for application avatar
 * @apiParam {String} [github]  github id/name for this app
 * @apiParam {Object[]} [inputs]    Input datatypes and tags
 * @apiParam {Object[]} [outputs]   Output datatypes and tags
 * @apiParam {String[]} [projects]  List of project IDs that this app should be exposed in 
 *
 * @apiParam {String} [dockerhub]  
 *
 * @apiParam {String[]} [admins]  List of admins (auth sub)
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         Updated App
 */
router.put('/:id', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    var id = req.params.id;
    common.validate_projects(req.user, req.body.projects, err=>{
        if(err) return next(err);
        db.Apps.findById(id, (err, app)=>{
            if(err) return next(err);
            if(!app) return res.status(404).end();
            if(!canedit(req.user, app)) {
                return res.status(401).end("you are not administartor of this app");
            } else {
                
                //apply user update 
                delete req.body.user_id;
                delete req.body.create_date;
                for(var k in req.body) app[k] = req.body[k];

                async.series([
                    /* we don't need to do this anymore
                    //issue doi if doi isn't issued 
                    next=>{
                        if(app.doi) return next();
                        mint_doi((err, doi)=>{
                            if(err) return next(err);
                            //logger.debug("minting doi", doi);
                            app.doi = doi;
                        });
                    },
                    */

                    //update info from github
                    cb=>{
                        common.pull_appinfo(app.github, (err, info)=>{
                            if(err) return cb(err);
                            Object.assign(app, info);
                            cb();
                        });
                    },

                    //update datacite info
                    cb=>{
                        if(!app.doi) return cb(); //doi not set...skip

                        let metadata = common.compose_app_datacite_metadata(app);
                        common.doi_post_metadata(metadata, err=>{
                            if(err) {
                                logger.error("failed to update metadata for datacite");
                                logger.error(err);
                                return cb(); //sometime datacite is broken.. let's skip if this happens
                            }
                            /*
                            //shouldn't need to be updated but just in case..
                            let url = config.warehouse.url+"/app/"+app._id; 
                            common.doi_put_url(app.doi, url, cb);
                            */
                            cb();
                        });
                    },

                    //now save
                    cb=>{
                        app.save((err)=>{
                            if(err) return cb(err);
                            app = JSON.parse(JSON.stringify(app));
                            app._canedit = canedit(req.user, app);
                            cb();
                        });
                    },
                ], err=>{
                    if(err) return next(err);
                    res.json(app);
                });
            }
        });
    });
});

/**
 * @apiGroup App
 * @api {delete} /app/:id
 *                              Remove registered app (only by the user registered it)
 * @apiDescription              Mark the application as removed
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 */
router.delete('/:id', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    var id = req.params.id;
    //TODO - prevent user from removing app that's in use..
    db.Apps.findById(req.params.id, (err, app)=>{
        if(err) return next(err);
        if(!app) return next(new Error("can't find the app with id:"+req.params.id));
        if(canedit(req.user, app)) {
            /*physically remove
            app.remove().then(function() {
                res.json({status: "ok"});
            }); 
            */
            app.removed = true;
            app.save(err=>{
                if(err) return next(err);
                res.json({status: "ok"});
            }); 
        } else return res.status(401).end();
    });
});

module.exports = router;

