/*!
 * Decorator: @profile
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
import 'reflect-metadata';
import { ILogger } from '.';
import * as mt from 'microtime';

export type AllowedTimeFormat = 'microseconds' | 'milliseconds' | 'seconds';

/**
 * Environment variable IMQ_LOG_TIME=[1, 0] - enables/disables profiled
 * timings logging
 *
 * @type {boolean}
 */
export const IMQ_LOG_TIME = !!process.env['IMQ_LOG_TIME'];

/**
 * Environment variable IMQ_LOG_ARGS=[1, 0] - enables/disables profiled
 * call arguments to be logged
 *
 * @type {boolean}
 */
export const IMQ_LOG_ARGS = !!process.env['IMQ_LOG_ARGS'];

/**
 * Environment variable IMQ_LOG_TIME_FORMAT=['microseconds', 'milliseconds', 'seconds'].
 * Specifies profiled time logging format, by default is 'microseconds'
 *
 * @type {AllowedTimeFormat | string}
 */
export const IMQ_LOG_TIME_FORMAT: AllowedTimeFormat =
    <AllowedTimeFormat>process.env['IMQ_LOG_TIME_FORMAT'] || 'microseconds';

/**
 * Prints debug information
 *
 * @param {boolean} debugTime
 * @param {boolean} debugArgs
 * @param {string} className
 * @param {any[]} args
 * @param {string | symbol} methodName
 * @param {number} start
 * @param {ILogger} logger
 */
export function printDebugInfo(
    debugTime: boolean,
    debugArgs: boolean,
    className: string,
    args: any[],
    methodName: string | symbol,
    start: number,
    /* istanbul ignore next */
    logger: ILogger = console
) {
    if (debugTime) {
        const time = mt.now() - start;
        let timeStr = '';
        // istanbul ignore next
        switch (IMQ_LOG_TIME_FORMAT) {
            case 'milliseconds':
                timeStr = (time / 1000).toFixed(3) + ' ms';
                break;
            case 'seconds':
                timeStr = (time / 1000000).toFixed(3) + ' sec';
                break;
            default:
                timeStr = time + ' μs';
                break;
        }
        logger.log(`${className}.${methodName}() executed in ${timeStr}`);
    }

    if (debugArgs) {
        logger.log(
            `${className}.${methodName}() called with args: ${
                JSON.stringify(args, null, 2)}`
        );
    }
}

/**
 * Implements '@profile' decorator.
 *
 * @example
 * ~~~typescript
 * import { profile } from 'imq';
 *
 * class MyClass {
 *
 *     @profile(true) // forced profiling
 *     public myMethod() {
 *         // ...
 *     }
 *
 *     @profile() // profiling happened only depending on env DEBUG flag
 *     private innerMethod() {
 *         // ...
 *     }
 * }
 * ~~~
 *
 * @return {(
 *  target: any,
 *  methodName: (string|symbol),
 *  descriptor: TypedPropertyDescriptor<Function>
 * ) => void}
 */
export function profile(
    enableDebugTime?: boolean,
    enableDebugArgs?: boolean
) {
    let debugTime = IMQ_LOG_TIME;
    let debugArgs = IMQ_LOG_ARGS;

    if (typeof enableDebugTime === 'boolean') {
        debugTime = enableDebugTime;
    }

    if (typeof enableDebugArgs === 'boolean') {
        debugArgs = enableDebugArgs;
    }

    return function(
        target: any,
        methodName: string | symbol,
        descriptor: TypedPropertyDescriptor<Function>
    ) {
        /* istanbul ignore next */
        const original = descriptor.value || target[methodName];

        descriptor.value = function(...args: any[]) {
            if (!(debugTime || debugArgs)) {
                return original.apply(this, args);
            }

            /* istanbul ignore next */
            const className = typeof target === 'function' && target.name
                ? target.name              // static
                : target.constructor.name; // dynamic
            const start = mt.now();
            const result = original.apply(this, args);

            /* istanbul ignore next */
            if (result && typeof result.then === 'function') {
                // async call detected
                result.then((res: any) => {
                    printDebugInfo(
                        debugTime,
                        debugArgs,
                        className,
                        args,
                        methodName,
                        start,
                        this.logger
                    );

                    return res;
                });
                return result;
            }

            printDebugInfo(
                debugTime,
                debugArgs,
                className,
                args,
                methodName,
                start,
                this.logger
            );

            return result;
        };
    }
}
