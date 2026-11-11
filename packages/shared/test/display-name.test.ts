import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName } from '../src/displayName.ts';

test('displayName proper-cases all-caps and all-lowercase customer names', () => {
  const cases: [string, string][] = [
    ['SMITH TRUCKING LLC', 'Smith Trucking LLC'],
    ['smith trucking llc', 'Smith Trucking LLC'],
    ['ACME INC.', 'Acme Inc.'],
    ['ACME INC', 'Acme Inc'],
    ['JOHN DOE DBA DOE PLUMBING', 'John Doe DBA Doe Plumbing'],
    ['JOHN DOE D/B/A DOE PLUMBING', 'John Doe D/B/A Doe Plumbing'],
    ["PATRICK O'BRIEN", "Patrick O'Brien"],
    ["JOE'S PIZZA", "Joe's Pizza"],
    ['MARY SMITH-JONES', 'Mary Smith-Jones'],
    ['RONALD MCDONALD', 'Ronald McDonald'],
    ['THE BANK OF THE NORTH', 'The Bank of the North'],
    ['A&B AUTO BODY, INC.', 'A&B Auto Body, Inc.'],
    ['ROBERT SMITH JR', 'Robert Smith Jr'],
    ['HENRY FORD III', 'Henry Ford III'],
    ['J.R. SMITH', 'J.R. Smith'],
    ['SMITH LAW PLLC', 'Smith Law PLLC'],
    ['1ST AVENUE DELI', '1st Avenue Deli'],
    ['JOHN  A  SMITH', 'John  A  Smith'],
  ];
  for (const [input, expected] of cases) assert.equal(displayName(input), expected, input);
});

test('displayName leaves mixed-case names untouched', () => {
  for (const s of ['McDonald & Sons, Inc.', 'iRobot Corp', 'DeLuca LLC', 'John SMITH']) assert.equal(displayName(s), s);
});

test('displayName handles empty values', () => {
  assert.equal(displayName(''), '');
  assert.equal(displayName(undefined), '');
  assert.equal(displayName(null), '');
});
