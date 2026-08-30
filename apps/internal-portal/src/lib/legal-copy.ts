/**
 * LEGAL-1 — v1 legal copy, deliberately aligned with how the platform
 * actually behaves (assistive AI, consent-gated recording, bounded audio
 * retention). Do not add claims here without checking the behaviour exists.
 */
export interface LegalSection {
  heading?: string;
  paras: string[];
}
export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
  versionLine: string;
}

export const PRIVACY_POLICY: LegalDoc = {
  title: "Privacy Policy",
  intro:
    "HireOps is a hiring-operations platform operated by MindsSparc Pvt Ltd. When a hiring organisation uses HireOps, that organisation decides what personal data is collected in its hiring process and why; MindsSparc operates the platform on its behalf.",
  sections: [
    {
      heading: "What we process",
      paras: [
        "Candidate information submitted in an application (contact details, CV/resume, work history, expected compensation); records created during the hiring process (screening outcomes, interview schedules, feedback written by the hiring team, offers); account details for hiring-team users (name, work email, role); where a candidate has explicitly consented, interview recordings and their transcripts.",
      ],
    },
    {
      heading: "How AI is used",
      paras: [
        "Some features use AI to assist the hiring team — for example summarising notes, drafting job descriptions, or scoring an application against a role's stated requirements. AI on HireOps is assistive: it never rejects a candidate automatically, interview notes and AI-generated interview questions never score or rate a candidate, and every hiring decision is made by a person.",
      ],
    },
    {
      heading: "Recordings and consent",
      paras: [
        'Interviews are recorded only with the candidate\'s explicit consent, given in advance. Consent can be withdrawn at any time, and withdrawing it stops any further processing of the recording. The absence of consent is treated as "no" — nothing is recorded by default.',
      ],
    },
    {
      heading: "Retention",
      paras: [
        "Interview audio is deleted after the hiring organisation's configured retention period, and in every case no later than 90 days after the interview. Documents and application records are retained according to the hiring organisation's retention schedule. Consent records are kept as an audit trail.",
      ],
    },
    {
      heading: "Security",
      paras: [
        "Access to candidate data is restricted by role. Actions on the platform are audit-logged. Credentials and integration secrets are stored encrypted.",
      ],
    },
    {
      heading: "Your rights",
      paras: [
        "To access, correct, or request deletion of your personal data, contact the recruitment team of the organisation you applied to. Platform-level questions can be raised with MindsSparc via www.mindssparc.com.",
      ],
    },
  ],
  versionLine: "Version 1.0 · 29 August 2026 · This policy will be refined during the pilot.",
};

export const TERMS_OF_USE: LegalDoc = {
  title: "Terms of Use",
  intro:
    "These terms govern access to the HireOps platform, operated by MindsSparc Pvt Ltd and made available to authorised users of a hiring organisation.",
  sections: [
    {
      heading: "Accounts",
      paras: [
        "Your account is personal. Keep your credentials secure and do not share them. Your organisation's administrator controls the roles and access you hold.",
      ],
    },
    {
      heading: "Acceptable use",
      paras: [
        "Use the platform only for your organisation's legitimate recruitment activities. Do not attempt to access data beyond your role, extract data in bulk outside provided features, or use candidate information for any purpose other than the hiring process it was collected for.",
      ],
    },
    {
      heading: "AI-assisted features",
      paras: [
        "AI features are assistive tools. You remain responsible for decisions you take on the platform, including hiring decisions informed by AI-generated content.",
      ],
    },
    {
      heading: "Data",
      paras: [
        "Your organisation's data remains its own. MindsSparc processes it to operate the platform, as described in the Privacy Policy and the agreement with your organisation.",
      ],
    },
    {
      heading: "Availability",
      paras: [
        "The platform is provided on an as-is basis during the pilot. MindsSparc works to keep it available and correct but does not warrant uninterrupted or error-free operation.",
      ],
    },
    {
      heading: "Intellectual property",
      paras: [
        "The platform, its design, and its software remain the property of MindsSparc Pvt Ltd.",
      ],
    },
    {
      heading: "Contact",
      paras: ["Questions about these terms: MindsSparc Pvt Ltd, via www.mindssparc.com."],
    },
  ],
  versionLine: "Version 1.0 · 29 August 2026.",
};
