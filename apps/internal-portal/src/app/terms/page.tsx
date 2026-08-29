import { LegalArticle } from "@/components/legal/LegalArticle";
import { TERMS_OF_USE } from "@/lib/legal-copy";

export const metadata = { title: "Terms of Use · HireOps" };

export default function TermsPage() {
  return <LegalArticle doc={TERMS_OF_USE} />;
}
