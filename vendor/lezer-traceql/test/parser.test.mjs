import assert from 'node:assert/strict';
import test from 'node:test';
import { parser } from '../index.es.js';

function parsedNodes(query) {
  const nodes = [];
  parser.parse(query).iterate({
    enter(node) {
      nodes.push({ name: node.type.name, text: query.slice(node.from, node.to), error: node.type.isError });
    },
  });
  return nodes;
}

test('@> is a FieldOp with a complete double-quoted string RHS', () => {
  const query = '{span.enc.secret @> "cool"} | select(span.enc.secret)';
  const nodes = parsedNodes(query);
  assert.equal(nodes.some((node) => node.error), false);
  assert.deepEqual(nodes.filter((node) => node.name === 'FieldOp').map((node) => node.text), ['@>']);
  assert.deepEqual(nodes.filter((node) => node.name === 'String').map((node) => node.text), ['"cool"']);
  assert.ok(nodes.some((node) => node.name === 'Static' && node.text === '"cool"'));
  assert.ok(nodes.some((node) => node.name === 'AttributeField' && node.text === 'span.enc.secret'));
});

test('@> preserves escaped quoted strings and adjacent ordinary comparisons', () => {
  const query = '{span.enc.secret @> "a\\"b\\\\c" && span.http.status_code = 200}';
  const nodes = parsedNodes(query);
  assert.equal(nodes.some((node) => node.error), false);
  assert.deepEqual(nodes.filter((node) => node.name === 'FieldOp').map((node) => node.text), ['@>', '=']);
  assert.deepEqual(nodes.filter((node) => node.name === 'String').map((node) => node.text), ['"a\\"b\\\\c"']);
});

test('@> does not accept an incomplete string literal', () => {
  const nodes = parsedNodes('{span.enc.secret @> "unterminated}');
  assert.equal(nodes.some((node) => node.error), true);
});

test('ordinary negative substring and protected internal sequence predicates parse as complete field operators', () => {
  const query = '{span.http.route !@> "users" && span."bi.secret" !subarray_seq ["bi:v1:k:abc","bi:v1:k:bcd"]}';
  const nodes = parsedNodes(query);
  assert.equal(nodes.some((node) => node.error), false);
  assert.deepEqual(nodes.filter((node) => node.name === 'FieldOp').map((node) => node.text), ['!@>', '!subarray_seq']);
  const positive = parsedNodes('{span."bi.secret" subarray_seq ["bi:v1:k:abc"]}');
  assert.equal(positive.some((node) => node.error), false);
  assert.deepEqual(positive.filter((node) => node.name === 'FieldOp').map((node) => node.text), ['subarray_seq']);
});
