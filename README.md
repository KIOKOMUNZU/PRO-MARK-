PRO-MARK 3.9.6

Admin mark-entry control is now directly reachable from the Administrator Control Centre. Configured assessments show deadline controls and Save / Reopen actions. Teacher lock status now distinguishes a passed deadline from a manually CLOSED assessment.

# PRO-MARK 2.0.0 — Final Configuration Build

PRO-MARK is a multi-school marks, assessment, merit and report-card platform designed around isolated school tenants and three master academic templates.

## Master templates

- **JUNIOR:** PP1, PP2, Grade 1–9
- **SENIOR:** Grade 10–12
- **COMPLEX:** Grade 10–12 plus Form 3–4; no Junior School levels

Each school is created from a master template but starts with its own empty school data. School administrators control school identity: name, logo, motto, colours and contacts.

## Academic and assessment model

Academic Year → Term 1/2/3 → assessments → marks → results → merit → reports.

Assessments support CAT, tests, mid-term, end-term, mocks, final and custom assessments, with configurable maximum marks, weights, inclusion and combination groups.

Grading systems are configurable per school and can be attached to section, level, subject and/or assessment context. This prevents Junior/CBC and secondary grading rules from being hard-coded together.

## Merit

Merit calculates:

1. Each learner's average per subject.
2. Each learner's subjects ranked highest → lowest by subject average.
3. Each learner's overall average and total subject-average score.
4. Class-wide subject performance ranking, highest → lowest.
5. Official merit export as PDF.

## Reports

The report engine retains the polished A4 report-card direction of the earlier project while making identity, grading and academic context school-specific. It supports learner details, subject averages, grades/levels, teacher initials, automatic comments, strongest/weakest subject remarks, assessment trend, annual term trend, signatures and school branding.

Historical academic years can retain an identity snapshot so later branding changes do not rewrite the identity used by historical reports.

The PDF output is a PRO-MARK school-generated academic report, not an official examination certificate.

## Permissions

- **PLATFORM_OWNER:** creates and manages schools.
- **SCHOOL_ADMIN / ADMIN:** school-wide configuration and administration.
- **TEACHER / SENIOR_TEACHER:** mark entry only for assigned subject/class contexts.
- **HEADTEACHER:** supervision and report/result access.
- **CLASS_TEACHER:** class-specific responsibilities according to assignment.

## Existing database safety

This final package is designed to continue using the existing `pro_mark` database. **Do not recreate it and do not run `database/schema.sql` over an already configured database.**

The legacy `pro_mark_entry` database is separate and must not be modified by PRO-MARK 2.0.

## First run on Windows

1. Keep the existing `.env` in the project root. If needed, create it from `.env.example` with your own local PostgreSQL connection and a strong JWT secret.
2. In this project folder run:

```bat
npm install
npm start
```

3. Open `http://localhost:3000`.
4. Sign in with the existing Platform Owner or school-admin account.

## Existing database upgrade

The current project already contains the hardening migration used by the configured `pro_mark` database. The final code does not require a fresh database. If you are installing into a completely new database, run `database/schema.sql` followed by `database/001_hardening.sql` once.

## Excel import

The project includes the controlled Kauti workbook importer as a reference migration. It is dry-run by default and does not import passwords. For a different school's Excel workbook, inspect the workbook first and map its columns/sheets before committing the import. Do not guess column meanings.

## Verification

Run:

```bat
npm run check
```

This performs a JavaScript syntax and required-file smoke check without changing the database.

## PRO-MARK 2.1 production document/lifecycle additions
- Learner passport photographs are persistent learner identity data and may appear on authorised profiles/registers/reports.
- Admission number is optional; missing admission numbers remain blank. Existing `LEGACY-*` placeholders are cleared by the 2.1 migration.
- Teacher signatures, school stamps, school logo watermarking, effective-dated document assets, term opening/closing dates and school-branded report identity are supported.
- Report cards use a full-page star-frame/certificate treatment, school logo, watermark, learner passport, signatures and stamp where configured.
- Parent/guardian contacts, learner-parent links, announcements and communication history are supported. SMS is queued locally until a production SMS provider is configured.
- Learner movement events and Grade 9 completion/transition workflows remain governed by school roles and enrollment history; historical academic records are not overwritten.
- Apply `database/002_production_documents_lifecycle.sql` once to an existing PRO-MARK database after the existing hardening migration. Do not rerun the Kauti import.

## PRO-MARK 3.4.2 report-card preview
- Report cards can be previewed directly inside the Reports workspace as an authenticated A4 PDF.
- The explicit Preview report card action works with empty marks so the layout can be inspected before results are entered.
- PDF opening uses a popup-safe flow, with a clear browser pop-up message if blocked.
- Class Teacher quick-report links target the protected class PDF endpoint.


## PRO-MARK 3.4.5 highlights
- Platform Owner can activate, stop (suspend), archive, safely delete empty schools, and open any active/managed school portal without signing out.
- Platform Owner is treated as a super-admin inside a selected school portal while remaining a platform-level identity.
- Leadership roles can review school-wide results, merit lists and report cards across all classes.
- School logo is centered prominently in A4 report cards, with a large logo watermark; school stamp is centrally configured and reused by report cards and merit PDFs.
- Report cards remain one learner per A4 page, preserve subject-teacher initials, class/head-teacher details and professional remarks, and add subject rank plus year-on-year deviation information.
- Merit PDFs have a professional cover page and school branding.
- Incorrectly created classes can be removed when unused; classes with historical/academic data are safely archived instead of hard-deleted.

## 3.5 Subscription & Billing Control Centre
- Platform Owner manages configurable subscription plans, billing cycles and grace periods.
- Platform Owner controls active payment modes and their instructions (M-PESA, bank, card, mobile money, manual/offline, etc.).
- Each school has a separate subscription record; school status and billing status remain separate.
- Billing uses School → Subscription → Invoice → Payment → Receipt/verification records.
- Invoices support due dates, partial payments, pending verification, overdue and paid states.
- Platform Owner can assign a plan, record/verify a payment and send an in-portal payment reminder to a school.
- School Admins can view subscription/invoice/payment instructions and submit a payment reference for verification.
- Billing notifications are stored in the database and shown inside the school portal; external SMS/WhatsApp/payment-gateway automation is intentionally a later integration phase.
- Migration: `database/005_billing_and_subscriptions.sql` (do not rerun an already-applied migration).

## PRO-MARK 3.7 assessment and SMS configuration

Apply the additive migration `database/008_assessment_context_and_portal_sms.sql` after migration 007. Do not recreate the database and do not rerun `database/schema.sql` on an existing installation.

Assessments are now contextual to academic year, term, class and subject. The administrator can configure Opener, optional CATs, Mid Term and End Term. Each assessment stores its raw maximum mark (20/30/50/100/etc.) and an optional final-contribution weight so final conversion can be applied later without changing the original mark.

For live parent SMS, the application supports Africa's Talking directly:

- `SMS_PROVIDER=AFRICASTALKING`
- `SMS_AFRICA_TALKING_USERNAME=your_app_username`
- `SMS_AFRICA_TALKING_API_KEY=your_api_key`
- `SMS_AFRICA_TALKING_ENV=live` (or `sandbox` while testing)
- `SMS_AFRICA_TALKING_SENDER_ID=your_approved_sender_id` (optional until approved/required)

The results publication workflow only sends to guardians who are linked to the learner and have an active phone number, SMS enabled, and communication consent. Messages are recorded in `communication_messages` with delivery status/provider information.

Africa's Talking requires an account/app/API key and a sender ID or shortcode for production messaging. See the official getting-started and SMS guidance before enabling live sending.

## 3.8 Portal identity, compact administration and SMS delivery tracking

- Added the PRO-MARK platform logo and branded login/portal presentation.
- Added a compact administrator control-centre menu so the long management workspace is navigated module-by-module.
- Added Class Lists for all active grades/classes. Administrators can open registers; assigned Class Teachers can open their assigned class and add learners through the existing server-side class-teacher authorization.
- Added stronger direct SMS delivery handling for manual parent messages and results-ready messages when Africa's Talking is configured. Messages are recorded as SENT, FAILED or QUEUED with provider/error tracking.
- Run the additive migration `database/009_sms_delivery_tracking.sql` before using the enhanced SMS status fields.
- Never put Africa's Talking API keys in browser code; configure them only in the server/Render environment.

## PRO-MARK 3.8.5 assessment/class workflow repair
- Assessment Setup is class-wide: select year + term + class once, then selected main exams/CATs apply to all subjects assigned to that class.
- Main exams are Opener, optional Mid Term, and End Term. CAT 1/CAT 2 are a separate optional group controlled by the administrator.
- Term 3 does not force Mid Term; the UI defaults it off, while Terms 1 and 2 default it on. The administrator may change the selection before creating assessments.
- Teacher Mark Entry now follows Academic Year -> Term -> Class -> Subject -> Assessment, then loads the learners for that exact assigned class/subject.
- Class Lists are rendered after teacher/class-teacher assignments are loaded, and learner/class IDs are compared as strings to avoid UUID type mismatches.
- Added database/011_assessment_workflow_columns_repair.sql. Run it on an existing database to add missing assessment workflow columns, including deadline_at, published_at, submitted_at and class/subject context. This fixes the `column "deadline_at" of relation "assessments" does not exist` error.


## PRO-MARK 3.8.7 teacher learner-roster compatibility fix

- Teacher Mark Entry now includes active learners whose class membership is stored directly in `learners.class_id` when no academic-year enrollment exists.
- When an academic-year enrollment exists, that enrollment remains authoritative for the selected class; withdrawn/transferred/archived enrollments are excluded.
- Bulk mark saving uses the same learner-membership rule, so fallback learners can actually save marks.
- Teacher mark-sheet PDF uses the same roster rule.
- No database recreation or new migration is required for this fix.


## 3.9.6 corrected package
This package aligns the application version metadata at 3.9.6 and presents Teacher Mark Entry as a single mobile-friendly flow: Academic Year → Term → Assessment → Class → Subject → Learners. Existing database data is preserved; the server uses the existing assessment workflow compatibility check rather than recreating the database.
