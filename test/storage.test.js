const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const {
  getB2Config,
  isB2Enabled,
  uploadFile,
  listFiles,
  deleteFile,
  getDownloadUrl
} = require('../server/lib/storage');

const B2_ENV_KEYS = ['B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET', 'B2_ENDPOINT', 'B2_REGION'];

function withB2Env(vars, fn) {
  const previous = {};
  for (const key of B2_ENV_KEYS) previous[key] = process.env[key];
  for (const key of B2_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of B2_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test('isB2Enabled/getB2Config are false/null when required vars are missing', async () => {
  await withB2Env({}, () => {
    assert.equal(isB2Enabled(), false);
    assert.equal(getB2Config(), null);
  });
  await withB2Env({ B2_KEY_ID: 'id', B2_APPLICATION_KEY: 'key', B2_BUCKET: 'bucket' }, () => {
    // B2_ENDPOINT missing
    assert.equal(isB2Enabled(), false);
  });
});

test('isB2Enabled/getB2Config are true/populated when all required vars are set, with a default region', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'bucket',
    B2_ENDPOINT: 'https://s3.us-west-002.backblazeb2.com'
  }, () => {
    assert.equal(isB2Enabled(), true);
    assert.deepEqual(getB2Config(), {
      keyId: 'id',
      applicationKey: 'key',
      bucket: 'bucket',
      endpoint: 'https://s3.us-west-002.backblazeb2.com',
      region: 'us-west-002'
    });
  });
});

test('getB2Config honors an explicit B2_REGION override', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'bucket',
    B2_ENDPOINT: 'https://example.com',
    B2_REGION: 'eu-central-003'
  }, () => {
    assert.equal(getB2Config().region, 'eu-central-003');
  });
});

function fakeClient(handler) {
  return { send: async (command) => handler(command) };
}

test('uploadFile streams the local file to the configured bucket/key and returns its size', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    const tmpFile = path.join(os.tmpdir(), `storage-test-${Date.now()}.mp4`);
    await fs.writeFile(tmpFile, 'hello world');

    let seenInput = null;
    const client = fakeClient(async (command) => {
      seenInput = command.input;
      // Drain the body stream, like a real upload would, so the file handle
      // is released before the test cleans up the temp file below.
      await new Promise((resolve, reject) => {
        command.input.Body.on('data', () => {});
        command.input.Body.on('end', resolve);
        command.input.Body.on('error', reject);
      });
      return { ETag: '"abc"' };
    });

    const result = await uploadFile(tmpFile, 'videos/hello.mp4', { client });
    assert.equal(result.key, 'videos/hello.mp4');
    assert.equal(result.size, Buffer.byteLength('hello world'));

    assert.equal(seenInput.Bucket, 'my-bucket');
    assert.equal(seenInput.Key, 'videos/hello.mp4');
    assert.equal(seenInput.ContentLength, Buffer.byteLength('hello world'));
    assert.equal(seenInput.ContentType, 'application/octet-stream');

    await fs.unlink(tmpFile);
  });
});

test('uploadFile throws when B2 is not configured', async () => {
  await withB2Env({}, async () => {
    await assert.rejects(() => uploadFile('/tmp/whatever.mp4', 'key'), /not configured/);
  });
});

test('listFiles maps S3 objects to the {name,size,createdAt,modifiedAt} shape and follows pagination', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    const lastModified = new Date('2026-01-01T00:00:00Z');
    let call = 0;
    const client = fakeClient(async () => {
      call += 1;
      if (call === 1) {
        return {
          Contents: [{ Key: 'a.mp4', Size: 100, LastModified: lastModified }],
          IsTruncated: true,
          NextContinuationToken: 'token-2'
        };
      }
      return {
        Contents: [{ Key: 'b.mp4', Size: 200, LastModified: lastModified }],
        IsTruncated: false
      };
    });

    const files = await listFiles({ client });
    assert.deepEqual(files, [
      { name: 'a.mp4', size: 100, createdAt: lastModified, modifiedAt: lastModified },
      { name: 'b.mp4', size: 200, createdAt: lastModified, modifiedAt: lastModified }
    ]);
    assert.equal(call, 2);
  });
});

test('listFiles returns an empty array when the bucket has no objects', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    const client = fakeClient(async () => ({ Contents: undefined, IsTruncated: false }));
    assert.deepEqual(await listFiles({ client }), []);
  });
});

test('deleteFile sends a DeleteObjectCommand for the given key', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    let seenInput = null;
    const client = fakeClient(async (command) => {
      seenInput = command.input;
      return {};
    });

    await deleteFile('videos/old.mp4', { client });
    assert.deepEqual(seenInput, { Bucket: 'my-bucket', Key: 'videos/old.mp4' });
  });
});

test('listFiles/deleteFile throw when B2 is not configured', async () => {
  await withB2Env({}, async () => {
    await assert.rejects(() => listFiles(), /not configured/);
    await assert.rejects(() => deleteFile('key'), /not configured/);
  });
});

test('getDownloadUrl passes the bucket/key/expiry to the injected presign function and returns its result', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    let seenArgs = null;
    const presign = async (args) => {
      seenArgs = args;
      return 'https://example.com/presigned-url';
    };

    const url = await getDownloadUrl('videos/hello.mp4', { presign, expiresInSeconds: 120 });
    assert.equal(url, 'https://example.com/presigned-url');
    assert.deepEqual(seenArgs, { bucket: 'my-bucket', key: 'videos/hello.mp4', expiresInSeconds: 120 });
  });
});

test('getDownloadUrl defaults to a 60 second expiry', async () => {
  await withB2Env({
    B2_KEY_ID: 'id',
    B2_APPLICATION_KEY: 'key',
    B2_BUCKET: 'my-bucket',
    B2_ENDPOINT: 'https://example.com'
  }, async () => {
    let seenArgs = null;
    await getDownloadUrl('key', { presign: async (args) => { seenArgs = args; return 'url'; } });
    assert.equal(seenArgs.expiresInSeconds, 60);
  });
});

test('getDownloadUrl throws when B2 is not configured', async () => {
  await withB2Env({}, async () => {
    await assert.rejects(() => getDownloadUrl('key'), /not configured/);
  });
});

test('getDownloadUrl (real signing path) forces a Content-Disposition: attachment so the link downloads, not plays inline', async () => {
  // storage.js requires @aws-sdk/s3-request-presigner lazily on each call,
  // but require() is a process-wide cache, so patching its export here
  // (before calling the real, non-DI signing path) takes effect there too -
  // same technique test/downloadRoute.test.js uses for child_process.spawn.
  const presigner = require('@aws-sdk/s3-request-presigner');
  const realGetSignedUrl = presigner.getSignedUrl;
  let seenCommand = null;
  presigner.getSignedUrl = async (client, command) => {
    seenCommand = command;
    return 'https://example.com/signed';
  };

  try {
    await withB2Env({
      B2_KEY_ID: 'id',
      B2_APPLICATION_KEY: 'key',
      B2_BUCKET: 'my-bucket',
      B2_ENDPOINT: 'https://example.com'
    }, async () => {
      const client = { send: async () => ({}) };
      const url = await getDownloadUrl('My Video.mp4', { client });
      assert.equal(url, 'https://example.com/signed');
      assert.equal(seenCommand.input.Bucket, 'my-bucket');
      assert.equal(seenCommand.input.Key, 'My Video.mp4');
      assert.equal(seenCommand.input.ResponseContentDisposition, 'attachment; filename="My Video.mp4"');
    });
  } finally {
    presigner.getSignedUrl = realGetSignedUrl;
  }
});
