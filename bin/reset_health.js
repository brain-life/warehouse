#!/usr/bin/env node
const winston = require('winston');
const async = require('async');

const config = require('../api/config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../api/models');
const common = require('../api/common');

common.redis.on('ready', ()=>{
    logger.info("removing health.warehouse.*");
    common.redis.keys("health.warehouse.*", (err, keys)=>{
        if(err) throw err;
        if(keys.length == 0) {
            console.log("no keys to remove");
            process.exit(0);
        }
        common.redis.del(keys, (err, reps)=>{
            if(err) throw err;
            logger.debug(reps);
            process.exit(0);
        });
    });
});

