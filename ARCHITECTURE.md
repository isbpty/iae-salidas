# IAE Salidas - connected pilot architecture

The current browser-only demo remains the UX reference. The connected pilot should move trusted workflow state and permissions out of `localStorage`.

## Services

- **Web app**: parent, reception, gate, teacher, and admin views.
- **API**: authenticated workflow commands and read models.
- **PostgreSQL**: one-school data store with audit history.
- **Realtime channel**: pushes request, approval, gate, and notification changes to open screens.
- **WhatsApp bridge worker**: QR-linked session for a dedicated pilot number. It consumes inbound messages and emits normalized message events through the API. Keep the bridge behind an interface so it can later be replaced by the official API without rewriting school workflows.
- **Object storage**: pickup-person ID images and excuse attachments.

## Security boundary

The server, not the browser, must enforce roles. The current staff dropdown is demo-only. Every mutation records actor, role, timestamp, request ID, previous state, next state, and source channel. Pickup codes are random, expire with the dismissal, and are never sufficient without identity verification.

## Core records

- schools, users, staff_roles, families, students, guardians
- authorized_pickups and authorization_windows
- dismissal_requests and dismissal_events
- excuse_requests and excuse_events
- pickup_codes
- notifications and delivery_attempts
- whatsapp_sessions and inbound_messages
- attachments
- audit_events

## Workflow invariants

1. A guardian may request only for linked students.
2. Approval and rejection are server transactions with an audit event.
3. Gate checkout requires an approved request, valid authorization, unexpired code, and an authorized gate actor.
4. One-time pickup authorization requires guardian confirmation before checkout.
5. Both guardians receive status changes where configured; delivery attempts and failures are retained.
6. Teachers see only their assigned grades. Reception, gate, and admin permissions are enforced on every API command.
7. All clients receive the same stored state. Browser refreshes and separate devices do not fork the workflow.

## Pilot rollout

1. Run the new stack in demo transport mode with seeded school data.
2. Test role isolation, approval races, duplicate inbound messages, reconnects, and audit completeness.
3. Pair only a dedicated test WhatsApp number through QR after school approval.
4. Run parallel with existing school procedure before allowing operational pickups.
5. Keep a visible disconnect switch and documented fallback process.

## Deployment requirement

GitHub Pages may continue to host static assets, but the API, database, realtime service, file storage, and QR WhatsApp worker require a persistent runtime. The school AI Lab must choose or provide that host and its secret-management path before real pairing.
