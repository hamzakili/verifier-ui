import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderTree, filterFolderTree, batchDisplayStatus, isActiveJob, formatBytes, formatDuration, JOB_STATUS_META, BATCH_STATUS_META } from './bulkJobs.js';

const folders = [
  { id: 'c', folder_name: 'Client B', parent_folder_id: 'a' },
  { id: 'a', folder_name: 'Clients', parent_folder_id: null },
  { id: 'b', folder_name: 'client A', parent_folder_id: 'a' },
  { id: 'n', folder_name: 'November Campaign', parent_folder_id: null },
  { id: 'j', folder_name: 'Job_20261120_001', parent_folder_id: 'n' },
];

test('folder tree: nested, sorted case-insensitively', () => {
  const tree = buildFolderTree(folders);
  assert.deepEqual(tree.map((f) => f.folder_name), ['Clients', 'November Campaign']);
  assert.deepEqual(tree[0].children.map((f) => f.folder_name), ['client A', 'Client B']);
  assert.equal(tree[1].children[0].id, 'j');
});

test('folder search keeps ancestors of matches', () => {
  const tree = filterFolderTree(folders, 'client b');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].folder_name, 'Clients');
  assert.deepEqual(tree[0].children.map((f) => f.folder_name), ['Client B']);
  assert.equal(filterFolderTree(folders, 'zzz').length, 0);
});

test('batch display status reflects the job state', () => {
  assert.equal(batchDisplayStatus({ status: 'pending' }, 'paused'), 'paused');
  assert.equal(batchDisplayStatus({ status: 'pending' }, 'queued'), 'queued');
  assert.equal(batchDisplayStatus({ status: 'completed' }, 'paused'), 'completed');
});

test('every server status has display metadata', () => {
  for (const s of ['draft', 'queued', 'processing', 'pausing', 'paused', 'completed', 'completed_with_errors', 'failed', 'cancelling', 'cancelled']) {
    assert.ok(JOB_STATUS_META[s], s);
  }
  for (const s of ['pending', 'processing', 'saving', 'completed', 'failed', 'retrying', 'cancelled']) assert.ok(BATCH_STATUS_META[s], s);
  assert.equal(isActiveJob('processing'), true);
  assert.equal(isActiveJob('paused'), false);
});

test('formatting', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(null), '—');
});
