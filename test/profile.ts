/*!
 * profile() Function Unit Tests
 *
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
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
import { expect } from 'chai';
import * as sinon from 'sinon';
import { profile, ILogger } from '..';
import { logger } from './mocks';

class ProfiledClass {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile()
    public decoratedMethod(...args: any[]) {
        return args;
    }
}

class ProfiledClassTimed {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
    })
    public decoratedMethod() {}
}

class ProfiledClassArgued {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: false,
        enableDebugArgs: true,
    })
    public decoratedMethod() {}
}

class ProfiledClassTimedAndArgued {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
        enableDebugArgs: true,
    })
    public decoratedMethod() {}
}

describe('profile()', function() {
    beforeEach(() => {
        for (let prop of Object.keys(logger)) {
            logger[prop] = sinon.spy(logger, prop);
        }
    });

    afterEach(() => {
        for (let prop of Object.keys(logger)) {
            logger[prop].restore();
        }
    });

    it('should be a function', () => {
        expect(typeof profile).to.equal('function');
    });

    it('should be decorator factory', () => {
        expect(typeof profile()).to.equal('function');
    });

    it('should pass decorated method args with no change', () => {
        expect(new ProfiledClass().decoratedMethod(1, 2, 3))
            .to.deep.equal([1, 2, 3]);
    });

    it('should log time if enabled', () => {
        new ProfiledClassTimed().decoratedMethod();
        expect(logger.log.calledOnce).to.be.true;
    });

    it('should log args if enabled', () => {
        new ProfiledClassArgued().decoratedMethod();
        expect(logger.log.calledOnce).to.be.true;
    });

    it('should log time and args if both enabled', () => {
        new ProfiledClassTimedAndArgued().decoratedMethod();
        expect(logger.log.calledTwice).to.be.true;
    });
});
