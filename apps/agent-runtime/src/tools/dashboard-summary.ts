import { z } from 'zod';

/** Compact read model; it deliberately avoids mirroring Core domain entities. */
export const DashboardSummarySchema = z.object({
  businessDate: z.iso.date(),
  highlights: z.array(z.string().min(1).max(300)).max(20),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
