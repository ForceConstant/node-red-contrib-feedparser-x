module.exports = function (RED) {
  "use strict";
  let FeedParser = require("feedparser");
  let request = require("request");
  let url = require('url');
  let sha1 = require('sha1');

  function buildKey(url, key) {
    return sha1(url) + "-" + key;
  }

  function FeedParseNode(config) {
    RED.nodes.createNode(this, config);
    let node = this;

    var getFeed = function (msg) {
      let init_send = msg.init_send || false;
      let is_existent = true;
      let keep_size = msg.keep_size || 30;

      if (!msg.payload) {
        node.error(RED._("feedparsex.errors.invalidurl"));
        return;
      }
      let feed_url = msg.payload;
      let parsed_url = url.parse(feed_url);
      if (!(parsed_url.host || (parsed_url.hostname && parsed_url.port)) && !parsed_url.isUnix) {
        node.error(RED._("feedparsex.errors.invalidurl"));
        return;
      }

      let seenKey = buildKey(feed_url, "seen");

      let nodeContext = node.context();
      nodeContext.get(seenKey, "redis", function (error, seen) {
        // get feed seen table
        if (error) {
          node.error(error);
          return;
        }
        is_existent = !!seen;
        if (!seen) {
          seen = {};
        }
        // request feed
        var req = request(feed_url, {timeout: 10000, pool: false});
        //req.setMaxListeners(50);
        req.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36');
        req.setHeader('accept', 'text/html,application/xhtml+xml');

        var feedparser = new FeedParser();

        req.on('error', function (err) {
          node.error(err);
        });

        req.on('response', function (res) {
          if (res.statusCode !== 200) {
            node.warn(RED._("feedparsex.errors.badstatuscode") + " " + res.statusCode);
          } else {
            res.pipe(feedparser);
          }
        });

        feedparser.on('error', function (error) {
          node.error(error);
        });

        feedparser.on('readable', function () {
          let stream = this, article;

          while (article = stream.read()) {  // jshint ignore:line
            let guid = article.guid;
            if (!(guid in seen) || (seen[guid].article_date !== 0 && seen[guid].article_date !== article.date.getTime())) {
              seen[guid] = {
                article_date: article.date ? article.date.getTime() : 0,
                seen_date: new Date().getTime()
              }
              // is_existent denotes that there are not any cache in redis
              // init_send denotes that message can be sent whenever cache is clear
              //
              if(!(!is_existent && !init_send)){
                let data = JSON.parse(JSON.stringify(msg));
                data.topic = article.origlink || article.link;
                data.payload = article.description;
                data.article = article;
                node.send(data);
              }
            }
          }
        });

        feedparser.on('meta', function (meta) {
        });
        feedparser.on('end', function () {
          let seen_arr = [];
          Object.keys(seen).forEach(k => {
            seen_arr.push({
              id: k,
              article_date: seen[k].article_date,
              seen_date: seen[k].seen_date
            });
          });
          // sort from bottom to top
          seen_arr.sort((a, b) => (a.article_date > b.article_date)? 1: -1);
          // clear
          seen = {};
          seen_arr.slice(-keep_size).forEach(v => {
            seen[v.id] = {
              article_date: v.article_date,
              seen_date: v.seen_date
            };
          });
          // write back to redis
          nodeContext.set(seenKey, seen, "redis");
        });
      });
    }

    this.on("input", function (msg) {
      getFeed(msg);
    });
  }

  RED.nodes.registerType("feedparse-x", FeedParseNode);
}
