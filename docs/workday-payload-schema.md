# Workday sync payload schema

The shape of the JSON payload we write into `workday_sync_outbox.payload`
for every external sync event. The Wave 1 simulator only consumes it
through `generateMockWorkdayResponse`; the Phase 3 real connector reads
this doc to build the SOAP serialisation.

Event-type discriminator: `workday_sync_outbox.event_type` (free text).
Wave 1 ships one event type: `hire_employee`.

## `hire_employee`

Fires when a candidate accepts an offer via `/api/offers/accept/:token`.
The same `application_id` produces exactly one row — the
`business_key` is `hire:application:{application_id}` and the table
has a UNIQUE (tenant_id, business_key) constraint that idempotently
rejects duplicates.

### Payload

```ts
{
  pre_hire: {
    full_name: string;       // persons.full_name
    email: string;           // persons.email_primary
    phone: string;           // persons.phone_primary (normalised — digits only,
                             // E.164 prefix preserved if present)
    address?: {              // present once we capture address from the apply form
      city?: string;
      country?: string;
    };
  };
  position: {
    requisition_external_id: string;  // our requisitions.id; Phase 3
                                       // connector maps this to a Workday
                                       // Position WID
    title: string;                     // positions.title
    business_unit_name: string;        // business_units.name
    location: string;                  // offers.location, free-text
  };
  effective_date: string;    // ISO 8601 date (the offers.joining_date)
  compensation: {
    base_annual_inr_paise: number;             // offers.base_salary_inr_paise
    variable_target_annual_inr_paise: number | null;  // offers.variable_target_inr_paise
    joining_bonus_inr_paise: number | null;    // offers.joining_bonus_inr_paise
    currency: "INR";                           // hardcoded Wave 1
  };
  source: {
    application_id: string;  // applications.id — back-link
    offer_id: string;        // offers.id — back-link
    accepted_at: string;     // ISO 8601 timestamp of the candidate click
  };
}
```

### Notes for the Phase 3 SOAP connector

1. **Money units.** `base_annual_inr_paise` is integer paise
   (1 INR = 100 paise). SOAP `Currency` Amount field accepts decimals;
   divide by 100 before serialising.
2. **Date format.** `effective_date` is YYYY-MM-DD. Workday's SOAP
   `Effective_Date` is `date`, so direct pass-through works.
3. **WID mapping.** `requisition_external_id` is OUR opaque UUID, NOT
   a Workday WID. Phase 3 connector either (a) requires a mapping
   table from our requisition IDs to Workday Position WIDs, or (b)
   uses the `ExternalIntegrationID` reference type with the same UUID
   as the external id (Workday accepts arbitrary UUIDs there).
4. **Address.** Optional in Wave 1 because the apply form (CRS-01)
   doesn't ask. SOAP `Hire_Employee` requires at least one Address;
   the Phase 3 connector populates `business_unit` location as a
   fallback when `pre_hire.address` is absent.
5. **Idempotency at Workday.** The connector should pass a stable
   `Business_Process_Reason` or `External_Reference` derived from
   `business_key` so Workday's retry semantics align with our outbox.

## Mock response shape (Wave 1 simulator)

```ts
{
  status: "success";
  workday_reference: {
    type: "Pre-Hire";              // for hire_employee
    wid: string;                   // randomUUID()
    descriptor: string;            // "Pre-Hire: <full_name>"
  };
  effective_date: string;
  simulated_at: string;            // ISO timestamp
  simulation_notes: "This is a simulated response. In production, this would be the actual Workday SOAP response.";
}
```

The `simulation_notes` field is the honesty mechanism — anyone
inspecting via the Integration Health screen sees the value verbatim
and knows the response did not come from a real Workday tenant.

## Real-connector replacement plan (Phase 3)

The Wave-1 simulator lives at `apps/workers/src/lib/workday-simulation-drain.ts`.
Replace it with the same shape — a `drainWorkdayOutboxOnce` that:

1. Reads the same `event_type` + `payload` from the outbox.
2. Calls the appropriate SOAP service (via `@hireops/workday-client` —
   the package already exists as a stub).
3. On success: `status='sent'`, populate `provider_message_id` with the
   Workday `Event_Reference_ID`, store the full response in
   `simulated_response` (the column doubles as "real response" once
   simulation is gone — at that point it'll be renamed).
4. On failure: `status='failed'`, populate `last_error` with the SOAP
   fault.

`workday_sync_outbox` rows from before the real connector lands stay
`status='simulated'` — they're the historical record of what we'd
have sent if the connector had been live. The Integration Health
screen treats both 'simulated' and 'sent' as "success" for the
summary tiles.
