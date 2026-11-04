import { randomBytes } from 'node:crypto';

import type {
  IncidentDetail,
  ManualTicketResult,
  ShiftNote,
  StaffAttachment,
} from '@watchtower/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, uniqueEmail, type Harness, type TestClient } from '../testing/harness.js';
import { apiOrg, signIn, type ApiErrorBody, type Persona } from '../testing/ticketing.js';

// Staff uploads against the real application, Postgres, Redis and the MinIO of the compose stack.

let h: Harness;
let agent: Persona;
let lead: Persona;
let client: Persona;
let orgId: string;

/** A PNG with the chunk structure of a real file (the CRCs are not checked, only the lengths). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
}
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  pngChunk('IDAT', randomBytes(32)),
  pngChunk('IEND', Buffer.alloc(0)),
]);

/** WebP with an EXIF chunk that names a GPS position. */
function webpWithExif(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return Buffer.concat([
      Buffer.from(type),
      size,
      data,
      data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
  };
  const payload = Buffer.concat([
    Buffer.from('WEBP'),
    chunk('VP8L', randomBytes(11)),
    chunk('EXIF', Buffer.from('Exif--GPSLatitude-secret')),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from('RIFF'), size, payload]);
}

/** GIF with a comment extension that carries a location. */
function gifWithComment(): Buffer {
  return Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([1, 0, 1, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xfe, 11]),
    Buffer.from('GPSLatitude!'.slice(0, 11)),
    Buffer.from([0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
  ]);
}

/** A JPEG with an EXIF segment that names a camera and a GPS position. */
function jpegWithExif(): Buffer {
  const exif = Buffer.concat([Buffer.from('Exif\0\0GPSLatitude-secret'), randomBytes(8)]);
  const length = exif.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]),
    exif,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
  ]);
}

beforeAll(async () => {
  h = await startHarness();
  agent = await signIn(h, 'agent');
  lead = await signIn(h, 'lead');
  orgId = (await apiOrg(lead, { name: 'Upload Org' })).id;
  client = await signIn(h, 'client', orgId, 'Upload Client');
});

afterAll(async () => {
  await h.close();
});

function form(name: string, bytes: Uint8Array, field = 'file'): FormData {
  const data = new FormData();
  data.append(field, new Blob([Buffer.from(bytes)]), name);
  return data;
}

async function upload(who: Persona, name: string, bytes: Uint8Array) {
  return who.client.post<StaffAttachment & ApiErrorBody>('/v1/uploads', form(name, bytes));
}

async function bytesOf(client: TestClient, id: string): Promise<Buffer> {
  const response = await client.get(`/v1/uploads/${id}`);
  expect(response.status).toBe(200);
  return Buffer.from(response.bytes);
}

describe('POST /v1/uploads', () => {
  it('stores an image, answers a reference, and gives the same bytes back as a download', async () => {
    const response = await upload(agent, 'screenshot.png', PNG);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      filename: 'screenshot.png',
      contentType: 'image/png',
      size: PNG.length,
    });
    expect(Object.keys(response.body).sort()).toEqual(['contentType', 'filename', 'id', 'size']);

    const file = await agent.client.get(`/v1/uploads/${response.body.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await bytesOf(agent.client, response.body.id)).toEqual(PNG);
  });

  it('removes EXIF from a JPEG before storing it', async () => {
    const response = await upload(agent, 'photo.jpg', jpegWithExif());
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stored = await bytesOf(agent.client, response.body.id);
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored[0]).toBe(0xff);
    expect(stored[1]).toBe(0xd8);
  });

  it('removes metadata from WebP and GIF too, and refuses an image it cannot read (fail closed)', async () => {
    const webp = await upload(agent, 'shot.webp', webpWithExif());
    expect(webp.status, JSON.stringify(webp.body)).toBe(201);
    const storedWebp = await bytesOf(agent.client, webp.body.id);
    expect(storedWebp.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(storedWebp.subarray(0, 4).toString()).toBe('RIFF');
    expect(storedWebp.readUInt32LE(4)).toBe(storedWebp.length - 8);

    const gif = await upload(agent, 'loop.gif', gifWithComment());
    expect(gif.status, JSON.stringify(gif.body)).toBe(201);
    const storedGif = await bytesOf(agent.client, gif.body.id);
    expect(storedGif.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(storedGif.at(-1)).toBe(0x3b);

    const broken = await upload(agent, 'broken.png', PNG.subarray(0, PNG.length - 20));
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe('attachment_rejected');
  });

  it('refuses what the bytes say is not an accepted file, and a name that lies', async () => {
    const svg = await upload(
      agent,
      'logo.png',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    expect(svg.status).toBe(400);
    expect(svg.body.code).toBe('attachment_rejected');
    const lie = await upload(agent, 'notes.txt', PNG);
    expect(lie.status).toBe(400);
    const none = await agent.client.post<ApiErrorBody>('/v1/uploads', form('a.png', PNG, 'other'));
    expect(none.status).toBe(400);
  });

  it('needs a session and refuses a client', async () => {
    expect((await h.client().post('/v1/uploads', form('a.png', PNG))).status).toBe(401);
    expect((await upload(client, 'a.png', PNG)).status).toBe(403);
    const mine = await upload(agent, 'a.png', PNG);
    expect((await client.client.get(`/v1/uploads/${mine.body.id}`)).status).toBe(403);
    expect((await h.client().get(`/v1/uploads/${mine.body.id}`)).status).toBe(401);
  });

  it('writes the upload and the download to the audit log', async () => {
    const mine = await upload(agent, 'audit.png', PNG);
    await agent.client.get(`/v1/uploads/${mine.body.id}`);
    const rows = await h.db.owner.pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at`,
      [mine.body.id],
    );
    expect(rows.rows.map((row) => row.action)).toEqual(['upload.create', 'upload.download']);
  });
});

describe('what the references attach to', () => {
  it('a shift note keeps the files and lists them, and only the uploader can attach them', async () => {
    const mine = await upload(agent, 'note.png', PNG);
    const created = await agent.client.post<ShiftNote>('/v1/shift-notes', {
      audience: 'next_shift',
      body: 'Look at this chart',
      attachmentIds: [mine.body.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.attachments).toEqual([mine.body]);

    const stolen = await lead.client.post<ApiErrorBody>('/v1/shift-notes', {
      audience: 'next_shift',
      body: 'Using their file',
      attachmentIds: [mine.body.id],
    });
    expect(stolen.status).toBe(400);
    const tooMany = await agent.client.post('/v1/shift-notes', {
      audience: 'next_shift',
      body: 'x',
      attachmentIds: Array.from({ length: 11 }, () => crypto.randomUUID()),
    });
    expect(tooMany.status).toBe(400);
  });

  it('an incident note keeps the references in the timeline', async () => {
    const incident = await lead.client.post<IncidentDetail>('/v1/incidents', {
      title: 'upload probe',
      severity: 'SEV4',
    });
    expect(incident.status).toBe(201);
    const mine = await upload(lead, 'graph.png', PNG);
    const note = await lead.client.post(`/v1/incidents/${incident.body.id}/notes`, {
      text: 'CPU graph',
      attachmentIds: [mine.body.id],
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const detail = await lead.client.get<IncidentDetail>(`/v1/incidents/${incident.body.id}`);
    const entry = detail.body.timeline.find((item) => item.type === 'note');
    expect(entry?.payload.attachments).toEqual([mine.body]);
  });

  it('a ticket filed by hand carries the file on its first message, served by the ticket route', async () => {
    const mine = await upload(agent, 'error.png', PNG);
    const created = await agent.client.post<ManualTicketResult>('/v1/tickets/manual', {
      orgId,
      channel: 'phone',
      subject: 'Screenshot from the call',
      body: 'The customer sent a screenshot.',
      requester: { email: uniqueEmail('caller', 'customer.example'), name: 'Caller' },
      attachmentIds: [mine.body.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = created.body.ticket.key;
    const rows = await h.db.owner.pool.query<{ id: string }>(
      `SELECT m.id FROM message m JOIN ticket t ON t.id = m.ticket_id WHERE t.id = $1`,
      [created.body.ticket.id],
    );
    const messageId = rows.rows[0]?.id ?? '';
    const file = await agent.client.get(`/v1/tickets/${key}/messages/${messageId}/attachments/0`);
    expect(file.status).toBe(200);
  });
});
