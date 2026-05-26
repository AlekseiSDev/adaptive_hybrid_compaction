// GAIA task schema (Track K). Per docs/design/K_gaia.md §2.4.
//
// Schema for items in references/gaia/data/gaia_validation_30.json
// (Holosophus snapshot of upstream gaia-benchmark/GAIA validation split).

import { z } from 'zod'

export const GaiaTaskSchema = z.object({
  idx: z.number().int().min(0),
  question: z.string().min(1),
  answer: z.string().min(1),
  level: z.enum(['1', '2', '3']),
  has_file: z.boolean(),
  file_path: z.string(),
})

export type GaiaTask = z.infer<typeof GaiaTaskSchema>
