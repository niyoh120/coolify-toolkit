// Zod schemas validating every HTTP input and the external responses we rely on.
import { z } from 'zod';

export const policySchema = z.enum(['ignore', 'notify', 'manual', 'auto']);

/** Digest: sha256:<64 hex>. */
export const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'digest must be sha256:<64 lowercase hex>');
/** Coolify application tag field encoding of a digest. */
export const coolifyDigestTagSchema = z
  .string()
  .regex(/^sha256-[a-f0-9]{64}$/, 'coolify digest tag must be sha256-<64 lowercase hex>');
/** Compose image digest suffix. */
export const composeDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'compose digest must be sha256:<64 lowercase hex>');

export const platformSchema = z
  .string()
  .regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9-]+)?$/, 'platform must be os/arch[/variant]');

/** Update user-visible resource fields. */
export const resourcePatchSchema = z
  .object({
    policy: policySchema.optional(),
    sourceRegistry: z.string().trim().min(1).max(253).optional(),
    sourceRepository: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/)
      .max(255)
      .optional(),
    sourceTag: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/)
      .optional(),
    targetPlatform: platformSchema.nullable().optional(),
    /** 资源级检查调度覆盖；null/空串 = 使用全局默认。 */
    checkCron: z.string().max(64).nullable().optional(),
  })
  .strict();

export const checkRequestSchema = z
  .object({
    /** Omit for a full scan; otherwise only the selected resources are checked. */
    resourceIds: z.array(z.number().int().positive()).max(200).optional(),
  })
  .strict();

export const batchPolicySchema = z
  .object({
    resourceIds: z.array(z.number().int().positive()).min(1).max(500),
    policy: policySchema,
  })
  .strict();

export const updateRequestSchema = z
  .object({
    candidateDigest: digestSchema.optional(),
    /** Token proving the user saw a preview of exactly this candidate. */
    previewToken: z.string().min(16).max(200).optional(),
    /** Skip preview: the server takes the latest fresh observation as candidate. */
    skipPreview: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => v.skipPreview === true || (v.candidateDigest != null && v.previewToken != null),
    'candidateDigest+previewToken or skipPreview required',
  );

export const confirmRequestSchema = z
  .object({
    /** What the user confirmed: the candidate digest now believed live. */
    digest: digestSchema,
  })
  .strict();

export const settingsPatchSchema = z
  .object({
    syncCron: z.string().min(5).max(100).optional(),
    checkCron: z.string().min(5).max(100).optional(),
    cronTimezone: z.string().min(1).max(64).optional(),

    globalPaused: z.boolean().optional(),
  })
  .strict();

// --- Coolify API response schemas (field access is validated, never trusted) ---

export const coolifyApplicationSchema = z.object({
  id: z.number().nullish(),
  uuid: z.string(),
  name: z.string().nullish(),
  project: z
    .object({ uuid: z.string().nullish(), name: z.string().nullish() })
    .nullish()
    .transform((v) => v ?? undefined),
  environment: z
    .object({
      uuid: z.string().nullish(),
      name: z.string().nullish(),
      project: z.object({ uuid: z.string().nullish() }).nullish(),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  destination: z
    .object({ id: z.number().nullish(), name: z.string().nullish() })
    .nullish()
    .transform((v) => v ?? undefined),
  fqdn: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  build_pack: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  docker_registry: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  docker_image: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  docker_image_tag: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  /** v4.3.23 pull-based apps store the image here instead of docker_image/tag. */
  docker_registry_image_name: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  docker_registry_image_tag: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  docker_compose_raw: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  updated_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

/** Loose entry from the aggregate /resources endpoint (topology detection only). */
export const coolifyResourceEntrySchema = z.object({
  type: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  uuid: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  /** Flat server (service entries); carries uuid/name/metadata. */
  destination_id: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
  server: z
    .object({
      uuid: z
        .string()
        .nullish()
        .transform((v) => v ?? null),
      name: z
        .string()
        .nullish()
        .transform((v) => v ?? null),
      server_metadata: z
        .object({
          arch: z
            .string()
            .nullish()
            .transform((v) => v ?? null),
        })
        .nullish()
        .transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  destination: z
    .object({
      id: z
        .number()
        .nullish()
        .transform((v) => v ?? null),
      server: z
        .object({
          uuid: z
            .string()
            .nullish()
            .transform((v) => v ?? null),
          name: z
            .string()
            .nullish()
            .transform((v) => v ?? null),
          server_metadata: z
            .object({
              arch: z
                .string()
                .nullish()
                .transform((v) => v ?? null),
            })
            .nullish()
            .transform((v) => v ?? null),
        })
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
});

export type CoolifyResourceEntry = z.infer<typeof coolifyResourceEntrySchema>;

export const coolifyServiceSchema = z.object({
  id: z.number().nullish(),
  uuid: z.string(),
  name: z.string().nullish(),
  project: z
    .object({ uuid: z.string().nullish(), name: z.string().nullish() })
    .nullish()
    .transform((v) => v ?? undefined),
  environment: z
    .object({
      uuid: z.string().nullish(),
      name: z.string().nullish(),
      project: z.object({ uuid: z.string().nullish() }).nullish(),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  destination: z
    .object({ id: z.number().nullish(), name: z.string().nullish() })
    .nullish()
    .transform((v) => v ?? undefined),
  docker_compose_raw: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  updated_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export const coolifyServiceApplicationSchema = z.object({
  uuid: z.string(),
  name: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  human_name: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  image: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  fqdn: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  url: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  description: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export const coolifyDeploymentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  deployment_uuid: z.string(),
  application_id: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : String(v))),
  application_name: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  created_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  finished_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  updated_at: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export type CoolifyApplication = z.infer<typeof coolifyApplicationSchema>;
export type CoolifyService = z.infer<typeof coolifyServiceSchema>;
export type CoolifyServiceApplication = z.infer<typeof coolifyServiceApplicationSchema>;
export type CoolifyDeployment = z.infer<typeof coolifyDeploymentSchema>;
