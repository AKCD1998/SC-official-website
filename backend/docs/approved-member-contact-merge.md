Approved duplicate contacts
===========================

`lib/approvedMemberMerge.js` generates offline, transaction-scoped operator SQL;
there is no merge HTTP endpoint or automatic matching by name or shared phone.
Use only after the owner confirms each exact source/target identity and the
canonical AR code. Keep the customer cohort and generated SQL outside Git.

Apply the private audit migration, deploy the staff contact search, and install
the native approved-contact extension. Verify the exact approved two-phone
representation on HQ and every enabled branch. Wait for Ada -> SCCRM to mirror
the HQ contact before running the merge. The SQL also requires a ready Ada point
balance and refuses source accounts with financial, receipt, assignment or
medical dependencies; such accounts need a separately reviewed migration.

The canonical account keeps its AR code, primary phone, history and Ada points.
No points are added together. Original duplicate member profiles are retired,
not deleted, and hidden from the member directory. Original user credentials
and phone fields are retained; search aliases are not new login credentials.
Any source consents are attached to the confirmed canonical person with their
original fields unchanged and their previous ownership preserved in the private
merge audit. Registration/outbound review rows remain historical evidence.

Verify both phones in the directory and authenticated staff search, check the
canonical receipt/point result and native acknowledgement replay, then monitor
sync queues. Rollback must be separately reviewed against fresh evidence; never
overwrite later receipts, consents, customer edits or Ada point activity.
