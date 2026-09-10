# Mail and calendar blocks

Check the current server's get_reporting_guide and tool schemas first. Older
servers do not accept these blocks. Do not install or upgrade a skill to infer
server capability.

An email block contains draft:{to,cc?,bcc?,subject,body}, optional title,
attachments:[{asset_id}], and reply_to?:{from,subject?,date?,body}. Recipients are
comma-separated addresses. Upload actual bytes to the SAME session using
upload_attachment(session_id,filename,data:rawBase64,idempotency_key?) or the
binary POST /api/sessions/:id/attachments with X-Relaynote-Filename and existing
OAuth/API-key authentication. Do not expose credentials or route large Base64
through chat when a direct authenticated upload is available. Max 10 MiB per file,
20 files per block. Existing session access, quota and retention apply.

Gmail compose and mailto carry recipients, subject and body. They cannot attach
file bytes or preserve reply threads. Keep the UI's manual-download/attach and
copy-to-original-conversation instructions. Never replace attachments with links,
append Relaynote/session/asset URLs to outgoing messages, or claim the email was
sent. The human chooses the sending account and sends in their own mail app.

A calendar block contains title, optional description and source: complete
VCALENDAR 2.0 text. Supply UID, SUMMARY, DTSTART and DTEND/DURATION; include a
VTIMEZONE for named zones and the master for each RECURRENCE-ID. Max 2 MiB and
200 VEVENTs including exceptions. Preserve RRULE/RDATE/EXDATE, attendees, alarms,
and unfamiliar properties in the source. Prefer UTC or canonical fixed JST for
native registration; other timezone definitions remain available through ICS.

The human edits a private copy and explicitly connects Google, selects
a writable calendar, reviews all details and confirms registration. Outlook
controls are temporarily hidden; do not promise Outlook connection in this release. Appending
or publishing a block does not create events or send invitations. Invite-off
omits attendees for a personal copy. Invite-on creates new invitations with the
destination calendar’s organizer; previous organizer/response data is not carried over.
Unsupported provider fields stop registration before writes, with ICS export as
an alternative that retains the source. Do not silently remove rejected fields.

Registration may partially succeed. Use the UI's stored results and remaining-item
retry; do not create replacement blocks to work around an uncertain external
write. The selected series includes its recurrences and exceptions. Personal edits
and registration receipts are private to the viewer and do not appear in shared
MCP review results. Deployment and live provider configuration are separate work;
never claim live account integration was verified from screenshots or mocked tests.
