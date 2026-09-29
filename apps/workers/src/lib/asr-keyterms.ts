/**
 * ASR keyterms for one interview recording.
 *
 * Speech models spell proper nouns phonetically: a Solenis panel round came
 * back as "Manish from Solanas GBS" and "Raghumera", and the notes model then
 * repeated "Solanas" in its summary. The words most likely to be misheard are
 * exactly the ones the platform already knows — the employer, the candidate,
 * the panel and the role — so they are handed to the ASR vendor as a
 * vocabulary hint (`keyterms_prompt` on AssemblyAI).
 *
 * Only names and titles already on the interview go in. Nothing about the
 * candidate beyond their name, and nothing from the CV: this is a spelling
 * hint for the vendor, not context for a model to reason with.
 */

import { sql as poolSql } from "@hireops/db";

export interface InterviewKeytermContext {
  tenantDisplayName: string | null;
  candidateName: string | null;
  panelNames: (string | null)[];
  positionTitle: string | null;
}

/**
 * Pure: the ordered term list. Full names go in whole AND as their parts,
 * because a panellist is usually addressed by first name ("over to you,
 * Raghu") and the company by its short form ("Solenis" for "Solenis GBS
 * India"). The ASR client trims, de-duplicates and caps the list.
 */
export function buildInterviewKeyterms(ctx: InterviewKeytermContext): string[] {
  const terms: string[] = [];
  const addWithParts = (value: string | null) => {
    if (!value) return;
    const whole = value.trim();
    if (!whole) return;
    terms.push(whole);
    for (const part of whole.split(/\s+/)) {
      // Initials and short fillers ("of", "&") carry no spelling signal.
      if (part.length >= 3 && /[A-Za-z]/.test(part)) terms.push(part);
    }
  };
  addWithParts(ctx.tenantDisplayName);
  addWithParts(ctx.candidateName);
  for (const name of ctx.panelNames) addWithParts(name);
  if (ctx.positionTitle?.trim()) terms.push(ctx.positionTitle.trim());
  return terms;
}

/**
 * Loads the context for a recording's interview. Returns an empty list when
 * anything is missing — a missing hint must never fail a transcription.
 */
export async function loadInterviewKeyterms(
  tenantId: string,
  interviewId: string,
): Promise<string[]> {
  const [row] = await poolSql<
    {
      tenant_display_name: string | null;
      candidate_name: string | null;
      position_title: string | null;
      panel_names: (string | null)[] | null;
    }[]
  >`
    SELECT t.display_name AS tenant_display_name,
           p.full_name    AS candidate_name,
           pos.title      AS position_title,
           (
             SELECT array_agg(u.display_name ORDER BY ip.is_lead DESC, u.display_name)
             FROM public.interview_panelists ip
             JOIN public.tenant_user_memberships m ON m.id = ip.membership_id
             JOIN public.users u ON u.id = m.user_id
             WHERE ip.tenant_id = iv.tenant_id AND ip.interview_id = iv.id
           ) AS panel_names
    FROM public.interviews iv
    JOIN public.tenants t ON t.id = iv.tenant_id
    LEFT JOIN public.applications a ON a.tenant_id = iv.tenant_id AND a.id = iv.application_id
    LEFT JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    LEFT JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    LEFT JOIN public.requisitions r ON r.tenant_id = iv.tenant_id AND r.id = iv.requisition_id
    LEFT JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    WHERE iv.tenant_id = ${tenantId} AND iv.id = ${interviewId}
  `;
  if (!row) return [];
  return buildInterviewKeyterms({
    tenantDisplayName: row.tenant_display_name,
    candidateName: row.candidate_name,
    panelNames: row.panel_names ?? [],
    positionTitle: row.position_title,
  });
}
