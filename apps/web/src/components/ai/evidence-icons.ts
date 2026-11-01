import type { AiEvidenceKind } from '@watchtower/shared';
import {
  Database,
  FileText,
  GitCommitHorizontal,
  type LucideIcon,
  ScrollText,
  Ticket,
} from 'lucide-react';

/** One icon per kind of evidence, shared by the brief, the draft and the Evidence tab. */
export const EVIDENCE_ICONS: Record<AiEvidenceKind, LucideIcon> = {
  kb: FileText,
  ticket: Ticket,
  log: ScrollText,
  data: Database,
  repo: GitCommitHorizontal,
};
