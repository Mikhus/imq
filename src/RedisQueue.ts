/*!
 * Fast messaging queue over Redis
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import {
    redis,
    IRedisClient,
    IJson,
    IMessageQueue,
    IMQOptions,
    IMessage,
    ILogger,
    profile,
    uuid
} from '.';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as crypto from 'crypto';
import { gzipSync as gzip, gunzipSync as gunzip } from 'zlib';

export const DEFAULT_IMQ_OPTIONS: IMQOptions = {
    host: 'localhost',
    port: 6379,
    prefix: 'imq',
    logger: console,
    watcherCheckDelay: 5000,
    useGzip: false,
    safeDelivery: false,
    safeDeliveryTtl: 5000
};

/**
 * Returns SHA1 hash sum of the given string
 *
 * @param {string} str
 * @returns {string}
 */
export function sha1(str: string) {
    let sha: crypto.Hash = crypto.createHash('sha1');

    sha.update(str);

    return sha.digest('hex');
}

/**
 * Returns random integer between given min and max
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function intrand(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Compress given data and returns binary string
 *
 * @param {any} data
 * @returns {string}
 */
// istanbul ignore next
export function pack(data: any): string {
    return gzip(JSON.stringify(data)).toString('binary');
}

/**
 * Decompress binary string and returns plain data
 *
 * @param {string} data
 * @returns {any}
 */
// istanbul ignore next
export function unpack(data: string): string {
    return JSON.parse(gunzip(Buffer.from(data, 'binary')).toString());
}

/**
 * Class RedisQueue
 * Implements simple messaging queue over redis.
 */
export class RedisQueue extends EventEmitter implements IMessageQueue {

    [name: string]: any;

    /**
     * @event message (message: IJson, id: string, from: string)
     */

    private reader: IRedisClient;
    private static writers: { [key: string]: IRedisClient } = {};
    private watchers: { [key: string]: IRedisClient } = {};
    private initialized: boolean = false;
    private watchOwner = false;
    private signalsInitialized: boolean = false;
    private safeCheckInterval: any;
    private readonly redisKey: string;

    // noinspection JSMethodCanBeStatic
    /**
     * @type {IRedisClient}
     */
    private get writer(): IRedisClient {
        return RedisQueue.writers[this.redisKey];
    }

    // noinspection JSUnusedLocalSymbols
    private set writer(conn: IRedisClient) {
        RedisQueue.writers[this.redisKey] = conn;
    }

    /**
     * @type {IRedisClient}
     */
    private get watcher(): IRedisClient {
        return this.watchers[this.redisKey];
    }

    // noinspection JSUnusedLocalSymbols
    private set watcher(conn: IRedisClient) {
        this.watchers[this.redisKey] = conn;
    }

    /**
     * @type {ILogger}
     */
    private get logger(): ILogger {
        // istanbul ignore next
        return this.options.logger || console;
    };

    private scripts: { [name: string]: { code: string, checksum?: string } } = {
        moveDelayed: {
            code:
                'local messages = redis.call('+
                    '"zrangebyscore", KEYS[1], "-inf", ARGV[1]) '+
                'local count = table.getn(messages) '+
                'local message '+
                'local i = 1 '+
                'if count > 0 then '+
                    'while messages[i] do '+
                        'redis.call("lpush", KEYS[2], messages[i]) '+
                        'i = i + 1 '+
                    'end '+
                    'redis.call("zremrangebyscore", KEYS[1], "-inf", ARGV[1]) '+
                'end '+
                'return count'
        }
    };

    /**
     * Return a lock key for watcher connection
     *
     * @access private
     * @returns {string}
     */
    private get lockKey(): string {
        return `${this.options.prefix}:watch:lock`;
    }

    /**
     * Returns current queue key
     *
     * @access private
     * @returns {string}
     */
    private get key(): string {
        return `${this.options.prefix}:${this.name}`;
    }

    private readonly pack: Function;
    private readonly unpack: Function;

    public options: IMQOptions = DEFAULT_IMQ_OPTIONS;

    /**
     * @constructor
     * @param {string} name
     * @param {IMQOptions} [options]
     */
    constructor(
        public name: string,
        options?: Partial<IMQOptions>
    ) {
        super();

        this.options = Object.assign({}, DEFAULT_IMQ_OPTIONS, options || {});
        this.pack = this.options.useGzip ? pack : JSON.stringify;
        this.unpack = this.options.useGzip ? unpack : JSON.parse;
        this.redisKey = `${this.options.host}:${this.options.port}`;
    }

    /**
     * Establishes given connection channel by its' name
     *
     * @access private
     * @param {"reader" | "writer" | "watcher"} channel
     * @param {IMQOptions} options
     * @param {any} context
     * @returns {Promise<any>}
     */
    @profile()
    private async connect(
        channel: 'reader' | 'writer' | 'watcher',
        options: IMQOptions,
        context: any = this
    ) {
        // istanbul ignore next
        if (context[channel]) {
            return context[channel];
        }

        return new Promise((resolve, reject) => {
            context[channel] = <IRedisClient>redis.createClient(
                // istanbul ignore next
                options.port || 6379,
                // istanbul ignore next
                options.host || 'localhost'
            );
            context[channel].on('ready', async () => {
                this.logger.info(
                    '%s: %s channel connected, host %s, pid %s',
                    context.name, channel, this.redisKey, process.pid
                );

                await context[channel].client(
                    'setname',
                    `${options.prefix}:${context.name}:${channel
                    }:pid:${process.pid}:host:${os.hostname()}`
                );

                resolve(context[channel]);
            });
            // istanbul ignore next
            context[channel].on('error', (err: Error) => {
                this.initialized = false;
                this.logger.error(
                    `${context.name}: error connecting redis host ${
                        this.redisKey} on ${
                        channel}, pid ${process.pid}:`,
                    err
                );
                reject(err);
            });
            // istanbul ignore next
            context[channel].on('end', () => {
                this.initialized = false;
                this.logger.warn(
                    '%s: redis connection %s closed on host %s, pid %s!',
                    context.name, channel, this.redisKey, process.pid
                );
            });
            // istanbul ignore next
            context[channel].on('reconnecting', () => {
                this.initialized = false;
                this.logger.warn(
                    '%s: redis connection %s is reconnecting on host %s, ' +
                    'pid %s...',
                    context.name, channel, this.redisKey, process.pid
                );
            });
        });
    }

    /**
     * Processes given redis-queue message
     *
     * @access private
     * @param {[any , any]} message
     * @returns {RedisQueue}
     */
    @profile()
    private process(message: [any, any]): RedisQueue {
        let [queue, data] = message;

        // istanbul ignore next
        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            const { id, message, from } = this.unpack(data);
            this.emit('message', message, id, from);
        }

        catch (err) {
            // istanbul ignore next
            this.emit('error', err, 'OnMessage');
            // istanbul ignore next
            this.logger.error(
                `${this.name}: process error - message is invalid, pid ${
                    process.pid}, redis host ${this.redisKey}:`,
                err
            );
        }

        return this;
    }

    /**
     * Returns number of established watcher connections on redis
     *
     * @access private
     * @returns {Promise<number>}
     */
    // istanbul ignore next
    private async watcherCount(): Promise<number> {
        const rx = new RegExp(
            `\\bname=${this.options.prefix}:[\\S]+?:watcher:`
        );
        return (<any>await this.writer.client('list') || '')
            .split(/\r?\n/)
            .filter((client: string) => rx.test(client))
            .length;
    }

    /**
     * Processes delayed message by its given redis key
     *
     * @access private
     * @param {string} key
     * @returns {Promise<void>}
     */
    private async processDelayed(key: string) {
        if (this.scripts.moveDelayed.checksum) {
            await this.writer.evalsha(
                this.scripts.moveDelayed.checksum,
                2, `${key}:delayed`, key, Date.now()
            );
        }
    }

    /**
     * Setups watch process on delayed messages
     *
     * @access private
     * @returns {RedisQueue}
     */
    // istanbul ignore next
    private watch() {
        if (!this.watcher || this.watcher.__ready__) {
            return this;
        }

        try {
            this.writer.config('set', 'notify-keyspace-events', 'Ex');
        }

        catch (err) {
            this.emit('error', err, 'OnConfig');
            this.logger.warn(
                `${this.name}: events config error, pid ${
                    process.pid} on redis host ${this.redisKey}:`,
                err
            );
        }

        this.watcher.on('pmessage', async (...args: any[]) => {
            try {
                const key = args.pop().split(':');

                if (key.pop() !== 'ttl') {
                    return;
                }
                key.pop(); // msg id

                await this.processDelayed(key.join(':'));
            }

            catch (err) {
                this.emit('error', err, 'OnWatch');
                this.logger.error(
                    `${this.name}: watch error, pid ${
                        process.pid} on redis host ${this.redisKey}:`,
                    err
                );
            }
        });

        this.watcher.psubscribe(
            '__keyevent@0__:expired',
            `${this.options.prefix}:delayed:*`
        );

        // watch for expired unhandled safe queues
        if (this.options.safeDelivery && !this.safeCheckInterval) {
            this.safeCheckInterval = setInterval(async () => {
                if (!this.writer) {
                    clearInterval(this.safeCheckInterval);
                    delete this.safeCheckInterval;
                    return ;
                }

                const now = Date.now();
                let cursor: string = '0';

                while (true) {
                    try {
                        const data: Array<[string, string[]]> =
                            <any>await this.writer.scan(
                                cursor, 'match',
                                `${this.options.prefix}:*:worker:*`,
                                'count', '1000'
                            );

                        cursor = <any>data.shift();
                        const keys: string[] = <any>data.shift() || [];

                        if (keys.length) {
                            for (let key of keys) {
                                const kp: string[] = key.split(':');

                                if (Number(kp.pop()) >= now) {
                                    const qKey = `${kp.shift()}:${kp.shift()}`;
                                    await this.writer.rpoplpush(key, qKey);
                                }
                            }
                        }

                        if (cursor === '0') {
                            return ;
                        }
                    }

                    catch (err) {
                        this.emit('error', err, 'OnSafeDelivery');
                        clearInterval(this.safeCheckInterval);
                        delete this.safeCheckInterval;
                        return ;
                    }
                }
            }, this.options.safeDeliveryTtl);
        }

        this.watcher.__ready__ = true;

        return this;
    }

    /**
     * Unreliable but fast way of message handling by the queue
     */
    private readUnsafe() {
        process.nextTick(async () => {
            try {
                const key = this.key;

                while (true) {
                    if (!this.reader) {
                        break;
                    }

                    try {
                        const msg: any = await this.reader.brpop(key, 0);
                        this.process(msg);
                    } catch (err) {
                        // istanbul ignore next
                        if (err.message.match(/Stream connection ended/)) {
                            break;
                        }

                        // istanbul ignore next
                        // noinspection ExceptionCaughtLocallyJS
                        throw err;
                    }
                }
            }

            catch (err) {
                // istanbul ignore next
                this.emit('error', err, 'OnReadUnsafe');
                // istanbul ignore next
                this.logger.error(
                    `${this.name}: unsafe reader failed, pid ${
                        process.pid} on redis host ${this.redisKey}:`,
                    err
                );
            }
        });
    }

    /**
     * Reliable but slow method of message handling by message queue
     */
    private readSafe() {
        process.nextTick(async () => {
            try {
                const key = this.key;

                while (true) {
                    const expire: number = Date.now() +
                        Number(this.options.safeDeliveryTtl);
                    const workerKey = `${key}:worker:${uuid()}:${expire}`;

                    if (!this.reader || !this.writer) {
                        break;
                    }

                    try {
                        await this.reader.brpoplpush(this.key, workerKey, 0);
                    } catch (err) {
                        // istanbul ignore next
                        break;
                    }

                    const msg: any = await this.writer.lrange(
                        workerKey, -1, 1
                    );

                    this.process([key, msg]);
                    this.writer.del(workerKey);
                }
            }

            catch (err) {
                // istanbul ignore next
                this.emit('error', err, 'OnReadSafe');
                // istanbul ignore next
                this.logger.error(
                    `${this.name}: safe reader failed, pid ${
                        process.pid} on redis host ${this.redisKey}:`,
                    err
                );
            }
        });
    }

    /**
     * Initializes read process on redis message queue
     *
     * @returns {RedisQueue}
     */
    private read(): RedisQueue {
        // istanbul ignore next
        if (!this.reader) {
            this.logger.error(
                `${this.name}: reader connection is not initialized, pid ${
                    process.pid} on redis host ${this.redisKey}!`
            );

            return this;
        }

        const readMethod = this.options.safeDelivery
            ? 'readSafe'
            : 'readUnsafe';

        this[readMethod]();

        return this;
    }

    /**
     * Checks if watcher connection is locked
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async isLocked(): Promise<boolean> {
        return !!Number(await this.writer.exists(this.lockKey));
    }

    /**
     * Locks watcher connection
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async lock(): Promise<boolean> {
        return !!Number(await this.writer.setnx(this.lockKey, ''));
    }

    /**
     * Unlocks watcher connection
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async unlock(): Promise<boolean> {
        return !!Number(await this.writer.del(this.lockKey));
    }

    /**
     * Acquires owner for watcher connection to this instance of the queue
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async ownWatch() {
        const owned = await this.lock();

        if (owned) {
            Object.keys(this.scripts).forEach(async (script: string) => {
                try {
                    const checksum = this.scripts[script].checksum = sha1(
                        this.scripts[script].code);
                    const loaded = ((<any>await this.writer.script(
                        'exists',
                        checksum
                    )) || []).shift();

                    if (!loaded) {
                        await this.writer.script(
                            'load',
                            this.scripts[script].code
                        );
                    }
                }

                catch (err) {
                    this.emit('error', err, 'OnScriptLoad');
                    this.logger.error(
                        `${this.name}: script load error, pid ${
                            process.pid} on redis host ${this.redisKey}:`,
                        err
                    );
                }
            });

            this.watchOwner = true;
            await this.connect('watcher', this.options);
            this.watch();
        }
    }

    /**
     * Initializes single watcher connection across all queues with the same
     * prefix.
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async initWatcher() {
        return new Promise<void>(async (resolve, reject) => {
            try {
                if (!await this.watcherCount()) {
                    await this.ownWatch();

                    if (this.watchOwner && this.watcher) {
                        resolve();
                    }

                    else {
                        // check for possible dead-lock to resolve
                        setTimeout(async () => {
                            try {
                                const noWatcher = !await this.watcherCount();

                                if (await this.isLocked() && noWatcher) {
                                    await this.unlock();
                                    await this.ownWatch();
                                }

                                resolve();
                            }

                            catch (err) {
                                reject(err);
                            }
                        }, intrand(1, 50));
                    }
                }

                else {
                    resolve();
                }
            }

            catch (err) {
                this.logger.error(
                    `${this.name}: error initializing watcher, pid ${
                        process.pid} on redis host ${this.redisKey}`,
                    err
                );
                reject(err);
            }
        });
    }

    /**
     * Initializes and starts current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async start(): Promise<RedisQueue> {
        if (!this.name) {
            throw new TypeError(`${this.name}: No queue name provided!`);
        }

        if (this.initialized) {
            return this;
        }

        const connPromises = [];

        // istanbul ignore next
        if (!this.reader) {
            connPromises.push(this.connect('reader', this.options));
        }

        if (!this.writer) {
            connPromises.push(this.connect('writer', this.options));
        }

        await Promise.all(connPromises);

        if (!this.signalsInitialized) {
            // istanbul ignore next
            const free = async () => {
                if (this.watchOwner) {
                    await this.unlock();
                }

                process.exit(0);
            };

            process.on('SIGTERM', free);
            process.on('SIGINT', free);

            this.signalsInitialized = true;
        }

        await this.initWatcher();

        this.read();

        this.processDelayed(this.key).catch(
            // istanbul ignore next
            (err) => {
                this.emit('error', err, 'OnProcessDelayed');
                this.logger.error(
                    `${this.name}: error processing delayed queue, pid ${
                        process.pid} on redis host ${this.redisKey}`,
                    err
                );
            }
        );

        this.initialized = true;

        return this;
    }

    /**
     * Sends given message to a given queue (by name)
     *
     * @param {string} toQueue
     * @param {IJson} message
     * @param {number} [delay]
     * @param {Function} [errorHandler]
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async send(
        toQueue: string,
        message: IJson,
        delay?: number,
        errorHandler?: Function
    ): Promise<string> {
        // istanbul ignore next
        if (!this.writer) {
            await this.start();
        }

        const id = uuid();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;
        const packet = this.pack(data);
        const cb = (error: any) =>
            // istanbul ignore next
            error && errorHandler && errorHandler(error);

        if (delay) {
            this.writer.zadd(`${key}:delayed`, Date.now() + delay, packet,
                (err) => {
                    // istanbul ignore next
                    if (err) return cb(err);

                    this.writer.set(
                        `${key}:${id}:ttl`,
                        '', 'PX', delay, 'NX',
                        cb
                    );
                });
        }

        else {
            this.writer.lpush(key, packet, cb);
        }

        return id;
    }

    /**
     * Stops current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async stop(): Promise<RedisQueue> {
        if (this.reader) {
            this.reader.removeAllListeners();
            this.reader.end(false);
            this.reader.unref();
            delete this.reader;
        }

        this.initialized = false;

        return this;
    }

    /**
     * Gracefully destroys this queue
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async destroy() {
        this.removeAllListeners();

        if (this.safeCheckInterval) {
            clearInterval(this.safeCheckInterval);
            delete this.safeCheckInterval;
        }

        if (this.watcher) {
            this.watcher.removeAllListeners();
            this.watcher.end(false);
            this.watcher.unref();
            delete this.watchers[this.redisKey];
        }

        await this.stop();
        await this.clear();

        if (this.writer) {
            this.writer.removeAllListeners();
            this.writer.end(false);
            this.writer.unref();
            delete RedisQueue.writers[this.redisKey];
        }
    }

    /**
     * Clears queue data in redis;
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async clear(): Promise<RedisQueue> {
        if (!this.writer) {
            return this;
        }

        await Promise.all([
            this.writer.del(this.key),
            this.writer.del(`${this.key}:delayed`)
        ]);

        return this;
    }

}
