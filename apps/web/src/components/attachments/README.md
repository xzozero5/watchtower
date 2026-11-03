# attachments

Images and files on anything staff write: paste a screenshot, drop files, or pick them. Files upload
at once (`POST /v1/uploads`), the text is saved with `attachmentIds`, and the saved item shows the
files with `<AttachmentGallery>`.

```tsx
import {
  AttachmentDropZone,
  AttachmentGallery,
  AttachmentPicker,
  useAttachmentUpload,
} from '@/components/attachments';

const upload = useAttachmentUpload(); // { max?: number } default 10

<AttachmentDropZone upload={upload} disabled={saving}>   {/* paste + drop on the field */}
  <Textarea ... />
</AttachmentDropZone>
<AttachmentPicker upload={upload} disabled={saving} />    {/* button, list, retry, remove */}
<Button disabled={saving || upload.busy}>Save</Button>

save({ body, attachmentIds: upload.attachmentIds });      // ids of finished uploads only
// on success: upload.clear();

<AttachmentGallery attachments={note.attachments} />      {/* thumbnails + lightbox, files as rows */}
```

## `useAttachmentUpload(options?) -> AttachmentUpload`

| field | meaning |
|---|---|
| `items` | `UploadItem[]`: `key, name, size, type, status ('uploading' / 'done' / 'error'), attachment, errorKey, previewUrl` |
| `attachmentIds` | ids of the `done` items in order: send as `attachmentIds` |
| `busy` / `hasError` | disable submit while `busy`; `hasError` = a failed file is still listed |
| `issues` | files turned away on `add` (type, size, count) |
| `add(files)` / `remove(key)` / `retry(key)` / `clear()` | `clear()` after the text was saved; it never deletes anything on the server |

Checks before sending: not empty, at most `STAFF_UPLOAD_MAX_BYTES` (10 MB), extension in the portal list
(png, jpg, gif, webp, pdf, txt, csv, log). The api repeats them and decides the type from the bytes.

## Components

- `AttachmentPicker { upload, disabled?, hideHint?, className? }`
- `AttachmentDropZone { upload, disabled?, className?, children }`: wraps the text field. A paste is
  taken only when the clipboard carries files; text pastes are untouched. A pasted `image.png` is
  renamed `screenshot-YYYYMMDD-HHMMSS.png` (the word follows the UI language).
- `AttachmentGallery { attachments: StaffAttachment[], className? }`: images (by `contentType`) as
  thumbnails; Enter/Space opens the lightbox, `Esc` closes, arrows move, Tab stays inside, focus returns
  to the thumbnail. Other files are a row with a download button. Bytes come from
  `GET /v1/uploads/{id}` with the session cookie and are shown from blob URLs.
- `parseStaffAttachments(unknown)`: for jsonb payloads (incident timeline `payload.attachments`).

## Server side (for the ticket composer)

`StaffAttachment = { id, filename, contentType, size }` is what notes, handoffs and incident entries
carry. For a ticket message the api turns `attachmentIds` into `message.attachments` records with
`StaffUploadsService.messageRecords(userId, ids)` (apps/api/src/uploads); the existing
`GET /v1/tickets/{id}/messages/{messageId}/attachments/{index}` then serves them and
`<MessageAttachments>` lists them. `POST /v1/tickets/manual` already accepts `attachmentIds`; the reply
and note endpoints still need the same one-line wiring (`noteSchema` / `replySchema` +
`domain.tickets.reply({ attachments })`, which already exists for the portal).
