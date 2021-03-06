( // Module boilerplate to support browser globals, node.js and AMD.
  (typeof module !== "undefined" && function (m) { module.exports = m(require('stream'), require('events'), require('smith')); }) ||
  (typeof define === "function" && function (m) { define("vfs-socket/consumer", ["./stream-amd", "./events-amd", "smith"], m); }) ||
  (function (m) { window.consumer = m(window.stream, window.events, window.smith); })
)(function (stream, events, smith) {
"use strict";

var exports = {};

var Stream = stream.Stream;
var EventEmitter = events.EventEmitter;
var Agent = smith.Agent;

exports.smith = smith;
exports.Consumer = Consumer;

function inherits(Child, Parent) {
    Child.super_ = Parent;
    Child.prototype = Object.create(Parent.prototype, {
        constructor: { value: Child }
    });
}

function Consumer() {

    Agent.call(this, {

        // Endpoints for readable streams in meta.stream (and meta.process.{stdout,stderr})
        onData: onData,
        onEnd: onEnd,

        // Endpoint for writable stream at meta.stream (and meta.process.stdin)
        onClose: onClose,

        // Endpoints for writable streams at options.stream
        write: write,
        end: end,

        // Endpoint for readable streams at options.stream
        destroy: destroy,

        // Endpoint for processes in meta.process
        onExit: onExit,
        onProcessClose: onProcessClose,

        // Endpoint for watchers in meta.watcher
        onChange: onChange,

        // Endpoint for the remote vfs itself
        onEvent: onEvent
    });

    var streams = {}; // streams sent in options.stream
    var proxyStreams = {}; // Stream proxies given us by the other side
    var proxyProcesses = {}; // Process proxies given us by the other side
    var proxyWatchers = {}; // Watcher proxies given us by the other side
    var proxyApis = {};
    var handlers = {}; // local handlers for remote events
    var pendingOn = {}; // queue for pending on handlers.

    this.vfs = {
        ping: ping, // Send a simple ping request to the worker
        resolve:  route("resolve"),
        stat:     route("stat"),
        readfile: route("readfile"),
        readdir:  route("readdir"),
        mkfile:   route("mkfile"),
        mkdir:    route("mkdir"),
        rmfile:   route("rmfile"),
        rmdir:    route("rmdir"),
        rename:   route("rename"),
        copy:     route("copy"),
        symlink:  route("symlink"),
        watch:    route("watch"),
        connect:  route("connect"),
        spawn:    route("spawn"),
        execFile: route("execFile"),
        extend:   route("extend"),
        unextend: route("unextend"),
        use:      route("use"),
        emit: emit,
        on: on,
        off: off
    };
    var remote = this.remoteApi;

    // Resume readable streams that we paused when the channel drains
    // Forward drain events to all the writable proxy streams.
    this.on("drain", function () {
        Object.keys(streams).forEach(function (id) {
            var stream = streams[id];
            if (stream.readable && stream.resume) stream.resume();
        });
        Object.keys(proxyStreams).forEach(function (id) {
            var stream = proxyStreams[id];
            if (stream.writable) stream.emit("drain");
        });
    });

    // Cleanup streams, proxy streams, proxy processes, and proxy apis on disconnect.
    this.on("disconnect", function (err) {
        if (!err) {
            err = new Error("EDISCONNECT: vfs socket disconnected");
            err.code = "EDISCONNECT";
        }
        Object.keys(streams).forEach(function (id) {
            var stream = streams[id];
            stream.emit("close");
        });
        Object.keys(proxyStreams).forEach(onClose);
        Object.keys(proxyProcesses).forEach(function (pid) {
            var proxyProcess = proxyProcesses[pid];
            delete proxyProcesses[pid];
            proxyProcess.emit("exit", 1);
        });
        Object.keys(proxyWatchers).forEach(function (id) {
            var proxyWatcher = proxyWatchers[id];
            delete proxyWatchers[id];
            proxyWatcher.emit("error", err);
        });
        Object.keys(proxyApis).forEach(function (name) {
            var proxyApi = proxyApis[name];
            delete proxyApis[name];
            proxyApi.emit("error", err);
        });
    });

    var nextStreamID = 1;
    function storeStream(stream) {
        while (streams.hasOwnProperty(nextStreamID)) { nextStreamID++; }
        var id = nextStreamID;
        streams[id] = stream;
        stream.id = id;
        if (stream.readable) {
            stream.on("data", function (chunk) {
                if (remote.onData(id, chunk) === false) {
                    stream.pause && stream.pause();
                }
            });
            stream.on("end", function () {
                delete streams[id];
                remote.onEnd(id);
                nextStreamID = id;
            });
        }
        stream.on("close", function () {
            delete streams[id];
            remote.onClose(id);
            nextStreamID = id;
        });
        var token = {id: id};
        if (stream.hasOwnProperty("readable")) token.readable = stream.readable;
        if (stream.hasOwnProperty("writable")) token.writable = stream.writable;
        return token;
    }


    // options.id, options.readable, options.writable
    function makeStreamProxy(token) {
        var stream = new Stream();
        var id = token.id;
        stream.id = id;
        proxyStreams[id] = stream;
        if (token.hasOwnProperty("readable")) stream.readable = token.readable;
        if (token.hasOwnProperty("writable")) stream.writable = token.writable;

        if (stream.writable) {
            stream.write = function (chunk) {
                return remote.write(id, chunk);
            };
            stream.end = function (chunk) {
                if (chunk) remote.end(id, chunk);
                else remote.end(id);
            };
        }
        if (stream.readable) {
            stream.destroy = function () {
                remote.destroy(id);
            };
        }

        return stream;
    }
    function makeProcessProxy(token) {
        var process = new EventEmitter();
        var pid = token.pid;
        process.pid = pid;
        proxyProcesses[pid] = process;
        process.stdout = makeStreamProxy(token.stdout);
        process.stderr = makeStreamProxy(token.stderr);
        process.stdin = makeStreamProxy(token.stdin);
        process.kill = function (signal) {
            remote.kill(pid, signal);
        };
        return process;
    }

    function makeWatcherProxy(token) {
        var watcher = new EventEmitter();
        var id = token.id;
        watcher.id = id;
        proxyWatchers[id] = watcher;
        watcher.close = function () {
            remote.close(id);
            delete proxyWatchers[id];
        };
        return watcher;
    }

    function makeApiProxy(token) {
        var name = token.name;
        var api = proxyApis[name] = new EventEmitter();
        api.name = token.name;
        api.names = token.names;
        token.names.forEach(function (functionName) {
            api[functionName] = function () {
                var args = Array.prototype.slice.call(arguments);
                if (typeof args[args.length - 1] === "function") {
                    var callback = args[args.length - 1];
                    args[args.length - 1] = function (err, meta) {
                        if (meta && typeof meta === "object") {
                            return processCallback(err, meta, callback);
                        }
                        callback(err, meta);
                    };
                }
                remote.call(name, functionName, args);
            };
        });
        return api;
    }

    function onExit(pid, code, signal) {
        var process = proxyProcesses[pid];
        if (!process) return;
        // TODO: not delete proxy if close is going to be called later.
        // but somehow do delete proxy if close won't be called later.
        delete proxyProcesses[pid];
        process.emit("exit", code, signal);
    }
    function onProcessClose(pid) {
        var process = proxyProcesses[pid];
        if (!process) return;
        delete proxyProcesses[pid];
        process.emit("close");
    }
    function onData(id, chunk) {
        var stream = proxyStreams[id];
        if (!stream) return;
        stream.emit("data", chunk);
    }
    function onEnd(id) {
        var stream = proxyStreams[id];
        if (!stream) return;
        // TODO: not delete proxy if close is going to be called later.
        // but somehow do delete proxy if close won't be called later.
        delete proxyStreams[id];
        stream.emit("end");
    }
    function onClose(id) {
        var stream = proxyStreams[id];
        if (!stream) return;
        delete proxyStreams[id];
        stream.emit("close");
    }

    function onChange(id, event, filename) {
        var watcher = proxyWatchers[id];
        if (!watcher) return;
        watcher.emit("change", event, filename);
    }

    // For routing events from remote vfs to local listeners.
    function onEvent(name, value) {
        var list = handlers[name];
        if (!list) return;
        for (var i = 0, l = list.length; i < l; i++) {
            list[i](value);
        }
    }

    function write(id, chunk) {
        // They want to write to our real stream
        var stream = streams[id];
        if (!stream) return;
        stream.write(chunk);
    }
    function destroy(id) {
        var stream = streams[id];
        if (!stream) return;
        stream.destroy();
        delete streams[id];
        nextStreamID = id;
    }
    function pause(id) {
        var stream = streams[id];
        if (!stream) return;
        stream.pause && stream.pause();
    }
    function resume(id) {
        var stream = streams[id];
        if (!stream) return;
        stream.resume && stream.resume();
    }
    function end(id, chunk) {
        var stream = streams[id];
        if (!stream) return;
        delete streams[id];
        if (chunk) stream.end(chunk);
        else stream.end();
        nextStreamID = id;
    }

    function on(name, handler, callback) {
        if (handlers[name]) {
            handlers[name].push(handler);
            if (pendingOn[name]) {
                callback && pendingOn[name].push(callback);
                return callback();
            }
            return callback();
        }
        handlers[name] = [handler];
        var pending = pendingOn[name] = [];
        callback && pending.push(callback);
        return remote.subscribe(name, function (err) {
            for (var i = 0, l = pending.length; i < l; i++) {
                pending[i](err);
            }
            delete pendingOn[name];
        });
    }

    function off(name, handler, callback) {
        // First look for handler in local list and abort if it's not here.
        var list = handlers[name];
        if (!list) return callback();
        var index = list.indexOf(handler);
        if (index < 0) return callback();

        // Remove the handler from the local list
        list.splice(index, 1);
        // Finish if there are others left still
        if (list.length > 0) return callback();

        // If the list is empty, delete it and unsubscribe from the event source
        delete handlers[name];
        remote.unsubscribe(name, callback);
    }

    function emit() {
        remote.emit.apply(remote, arguments);
    }

    // Liven vfs-socket extras like streams and processes
    function processCallback(err, meta, callback) {
        if (err) return callback(err);
        if (meta.stream) {
            meta.stream = makeStreamProxy(meta.stream);
        }
        if (meta.process) {
            meta.process = makeProcessProxy(meta.process);
        }
        if (meta.watcher) {
            meta.watcher = makeWatcherProxy(meta.watcher);
        }
        if (meta.api) {
            meta.api = makeApiProxy(meta.api);
        }

        return callback(null, meta);
    }

    // Return fake endpoints in the initial return till we have the real ones.
    function route(name) {
        return function (path, options, callback) {
            if (!callback) throw new Error("Forgot to pass in callback for " + name);
            if (options.stream) {
                options.stream = storeStream(options.stream);
            }
            return remote[name].call(this, path, options, function (err, meta) {
                processCallback(err, meta, callback);
            });
        };
    }
    function ping(callback) {
        return remote.ping(callback);
    }


}
inherits(Consumer, Agent);

// Emit the wrapped API, not the raw one
Consumer.prototype._emitConnect = function () {
    this.emit("connect", this.vfs);
};

return exports;

});
