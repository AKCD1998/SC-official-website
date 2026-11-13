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

Existing AR families
--------------------

`lib/approvedExistingArMerge.js` supports explicitly confirmed existing Ada
families. Keep the family manifest private. It verifies each native snapshot
hash, current owner, phone and ready Ada balance before changing links. It keeps
the existing canonical account and its bills; only approved empty duplicate
profiles are retired into the private merge audit. A source with financial,
medical, assignment or session dependencies is refused. Imported alternate
owners must additionally have no login, email or verified identity.

For an unowned native code, the operator prepares an approved link and leaves
the normal HQ worker to publish its existing AR assignment. It does not insert
assignments or change native customer codes. Existing imported canonical
profiles may have their virtual `ADA-` display prefix removed and receive a
staff contact phone; original login fields are unchanged. The point projector
unions events for explicitly linked codes and retains its opening-balance and
duplicate-event guards. The operator never adds cached balances or writes point
rows. Verify the projector remains ready after combining a family.

Exact code lookups and the member directory recognize approved old native codes
on the active canonical account, including an alternate code whose former
profile was retired. They still reject two active owners for the same code.
