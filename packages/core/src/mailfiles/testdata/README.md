# Test data for the mail file readers

Real Outlook `.msg` files, made by Microsoft Outlook, used to test the MSG reader
(`../msg.ts`) against files that the `@tutao/oxmsg` writer did not produce. They are
unmodified copies from the test data of the msgreader project:

- Project: https://github.com/HiraokaHyperTools/msgreader (`test/` folder, master branch)
- License: Apache-2.0 (https://github.com/HiraokaHyperTools/msgreader/blob/master/LICENSE); the license text is in
  [`licenses/msgreader-LICENSE`](../../../../../licenses/msgreader-LICENSE) at the root of this repository
- Authors: the msgreader contributors; the message content is synthetic (addresses on
  `xmailserver.test` and `hmailserver.test`)

| File here                          | Original name in the project | What it covers |
| ---------------------------------- | ---------------------------- | -------------- |
| `outlook-attachments-headers.msg`  | `attachmentFiles.msg`        | received mail with original transport headers and three attachments (JPEG, PNG, TIFF) |
| `outlook-embedded-message.msg`     | `msgInMsg.msg`               | an embedded message (with its own transport headers, Japanese subject) next to a PNG attachment |
| `outlook-attachment-inline.msg`    | `attachAndInline.msg`        | an attachment and an inline image with a Content-ID in a rich text message |
| `outlook-ansi-japanese.msg`        | `nonUnicodeCP932.msg`        | 8-bit strings in the Japanese Windows code page (CP932), no Unicode properties |
| `outlook-contact.msg`              | `contactUnicode.msg`         | an Outlook contact (`IPM.Contact`): must be refused as not mail |
| `outlook-sticky-note.msg`          | `A memo.msg`                 | an Outlook note (`IPM.StickyNote`): must be refused as not mail |

`corrupt-endless-loop.msg` is `outlook-attachments-headers.msg` with a few bytes of the compound
file damaged (found by fuzzing). msgreader loops forever on it, which the reader's time limit has to
catch. It is a derived work of the same Apache-2.0 file and contains no other data.

Nothing else in this folder is generated from personal data. Do not add real mailboxes.
