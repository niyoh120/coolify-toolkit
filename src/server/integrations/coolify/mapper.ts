// Field-level mapping helpers for Coolify Application payloads.
import type { CoolifyApplication } from '../../../shared/schemas.js';

/**
 * Full image reference from either field pair. v4.3.23 pull-based apps store
 * the image under docker_registry_image_name/tag while classic apps use
 * docker_image/docker_image_tag; both appear in API payloads as null when absent.
 */
export function applicationImageRef(app: CoolifyApplication): string | null {
  if (app.docker_registry_image_name != null && app.docker_registry_image_name !== '') {
    return app.docker_registry_image_tag
      ? `${app.docker_registry_image_name}:${app.docker_registry_image_tag}`
      : app.docker_registry_image_name;
  }
  if (app.docker_image != null && app.docker_image !== '') {
    return app.docker_image_tag ? `${app.docker_image}:${app.docker_image_tag}` : app.docker_image;
  }
  return null;
}

/**
 * The tag field that carries the deployable tag for this app — the PATCH
 * target for digest pinning. Prefers the registry pair when present.
 */
export function applicationTagField(
  app: Pick<CoolifyApplication, 'docker_registry_image_name' | 'docker_image'>,
): 'docker_registry_image_tag' | 'docker_image_tag' {
  return app.docker_registry_image_name != null && app.docker_registry_image_name !== ''
    ? 'docker_registry_image_tag'
    : 'docker_image_tag';
}
