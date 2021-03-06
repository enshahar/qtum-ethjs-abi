/* eslint-disable */
/*
Primary Attribution
Richard Moore <ricmoo@me.com>
https://github.com/ethers-io

Note, Richard is a god of ether gods. Follow and respect him, and use Ethers.io!
*/

const Buffer = require('buffer').Buffer;
const utils = require('./utils/index.js');
const uint256Coder = utils.uint256Coder;
const coderBoolean = utils.coderBoolean;
const coderFixedBytes = utils.coderFixedBytes;
const coderAddress = utils.coderAddress;
const coderDynamicBytes = utils.coderDynamicBytes;
const coderString = utils.coderString;
const coderArray = utils.coderArray;
const paramTypePart = utils.paramTypePart;
const getParamCoder = utils.getParamCoder;

const {
  hexStringToBuffer,
  toHexStringNoPrefix,
  toHexString,
  configure,
} = utils

// function Result() { }
class Result {
  constructor(size = undefined) {
    if (size) {
      Object.defineProperty(this, "length", {
        value: size
      })
    }
  }

  // Implements iterator protocol for array-like destructuring and for..of loop.
  [Symbol.iterator]() {
    const size = this.length || 0

    let i = 0
    return {
      next: () => {
        const done = i > size - 1
        const v = {
          value: !done ? this[i] : undefined,
          done,
        }

        i++

        return v
      }
    }
  }
}

/**
 * @param {Array<string>} types
 * @param {any[]} values
 */
function encodeParams(types, values, noHexPrefix = false) {
  if (types.length !== values.length) {
    throw new Error(`[ethjs-abi] while encoding params, types/values mismatch, Your contract requires ${types.length} types (arguments), and you passed in ${values.length}`);
  }

  var parts = [];

  types.forEach(function (type, index) {
    var coder = getParamCoder(type);
    parts.push({ dynamic: coder.dynamic, value: coder.encode(values[index]) });
  });

  function alignSize(size) {
    return parseInt(32 * Math.ceil(size / 32));
  }

  var staticSize = 0, dynamicSize = 0;
  parts.forEach(function (part) {
    if (part.dynamic) {
      staticSize += 32;
      dynamicSize += alignSize(part.value.length);
    } else {
      staticSize += alignSize(part.value.length);
    }
  });

  var offset = 0, dynamicOffset = staticSize;
  const data = new Buffer(staticSize + dynamicSize);

  parts.forEach(function (part, index) {
    if (part.dynamic) {
      uint256Coder.encode(dynamicOffset).copy(data, offset);
      offset += 32;

      part.value.copy(data, dynamicOffset);
      dynamicOffset += alignSize(part.value.length);
    } else {
      part.value.copy(data, offset);
      offset += alignSize(part.value.length);
    }
  });

  if (noHexPrefix) {
    return toHexStringNoPrefix(data);
  } else {
    return toHexString(data);
  }
}

/**
 * Decode bytecode data from output names and types
 *
 * @param {string[]} names
 * @param {string[]} types
 * @param {(string | Buffer)} data
 * @param {boolean} useNumberedParams
 * @param {Result} values
 * @returns {Result}
 */
function decodeParams(names, types, data, useNumberedParams = true, values = new Result()) {
  // Names is optional, so shift over all the parameters if not provided
  if (arguments.length < 3) {
    data = types;
    types = names;
    names = [];
  }

  data = utils.hexOrBuffer(data);

  var offset = 0;
  types.forEach(function (type, index) {
    var coder = getParamCoder(type);

    if (coder.dynamic) {
      var dynamicOffset = uint256Coder.decode(data, offset);
      var result = coder.decode(data, dynamicOffset.value.toNumber());
      offset += dynamicOffset.consumed;
    } else {
      var result = coder.decode(data, offset);
      offset += result.consumed;
    }

    if (useNumberedParams) {
      values[index] = result.value;
    }

    if (names[index]) {
      values[names[index]] = result.value;
    }
  });
  return values;
}

// create an encoded method signature from an ABI object
function encodeSignature(method) {
  const signature = `${method.name}(${utils.getKeys(method.inputs, 'type').join(',')})`;
  const signatureEncoded = utils.keccak256(signature).slice(0, 8)

  return toHexString(signatureEncoded);
}

// encode method ABI object with values in an array, output bytecode
function encodeMethod(method, values) {
  const paramsEncoded = encodeParams(utils.getKeys(method.inputs, 'type'), values, true);

  return `${encodeSignature(method)}${paramsEncoded}`;
}

// decode method data bytecode, from method ABI object
function decodeMethod(method, data) {
  const outputNames = utils.getKeys(method.outputs, 'name', true);
  const outputTypes = utils.getKeys(method.outputs, 'type');

  return decodeParams(outputNames, outputTypes, utils.hexOrBuffer(data));
}

// decode method data bytecode, from method ABI object
function encodeEvent(eventObject, values) {
  return encodeMethod(eventObject, values);
}

function eventSignature(eventObject) {
  const signature = `${eventObject.name}(${utils.getKeys(eventObject.inputs, 'type').join(',')})`;

  return toHexString(utils.keccak256(signature));
}

// decode method data bytecode, from method ABI object
function decodeEvent(eventObject, data, topics, useNumberedParams = true) {
  const nonIndexed = eventObject.inputs.filter((input) => !input.indexed)
  const nonIndexedNames = utils.getKeys(nonIndexed, 'name', true);
  const nonIndexedTypes = utils.getKeys(nonIndexed, 'type');
  const event = decodeParams(
    nonIndexedNames, nonIndexedTypes, utils.hexOrBuffer(data), false,
    new Result(eventObject.inputs.length)
  );
  const topicOffset = eventObject.anonymous ? 0 : 1;

  eventObject.inputs.map((input, i) => {
    // FIXME: special handling for string and bytes

    if (input.indexed) {
      const topic = hexStringToBuffer(topics[i + topicOffset]);
      const coder = getParamCoder(input.type);
      event[input.name] = coder.decode(topic, 0).value;
    }

    if (useNumberedParams) {
      Object.defineProperty(event, i, {
        enumerable: false,
        value: event[input.name],
      });
    }
  });

  event.type = eventObject.name;

  return event;
}

// Decode a specific log item with a specific event abi
function decodeLogItem(eventObject, log, useNumberedParams = true) {
  if (eventObject && log.topics[0] === eventSignature(eventObject)) {
    return decodeEvent(eventObject, log.data, log.topics, useNumberedParams)
  }
}

// Create a decoder for all events defined in an abi. It returns a function which is called
// on an array of log entries such as received from getLogs or getTransactionReceipt and parses
// any matching log entries
function logDecoder(abi, useNumberedParams = true) {
  const eventMap = {}
  abi.filter(item => item.type === 'event').map(item => {
    eventMap[eventSignature(item)] = item
  })
  return function (logItems) {
    return logItems.map(log => decodeLogItem(eventMap[log.topics[0]], log, useNumberedParams)).filter(i => i)
  }
}


module.exports = {
  encodeParams,
  decodeParams,
  encodeMethod,
  decodeMethod,
  encodeEvent,
  decodeEvent,
  decodeLogItem,
  logDecoder,
  eventSignature,
  encodeSignature,
  configure,
};
