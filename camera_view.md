## Lighting

Three lights work together for SolidWorks-style illumination:

### 1. HemisphereLight (ambient gradient)
- **Sky color:** `0xddeeff` (cool blue-white)
- **Ground color:** `0x1a1a2e` (matches scene background)
- **Intensity:** 0.5
- Provides a natural sky/ground ambient gradient — objects facing up get cooler light, objects facing down get warmer fill.

### 2. AmbientLight (baseline fill)
- **Color:** `0xffffff` (white)
- **Intensity:** 0.15
- Ensures no surface is completely black, even in shadow.

### 3. DirectionalLight (camera-relative headlight)
- **Color:** `0xffffff` (white)
- **Intensity:** 0.85
- **Position:** Updated every frame in `_updateHeadlight()` to follow the camera — offset 5 units above and 3 units to the right of the camera position (in camera-local coordinates). The light target tracks the orbit controls target.
- **Shadow casting:** Enabled (see Shadows section below).

This headlight approach means the primary illumination always comes from roughly the same screen-space direction regardless of how the user orbits, providing consistent, natural-looking shading similar to SolidWorks.

## Shadows

### Renderer configuration
- **Shadow map:** Enabled, type `PCFSoftShadowMap` (percentage-closer filtering for soft edges)

### Directional light shadow settings
- **Map size:** 2048 × 2048 pixels
- **Shadow camera:** Orthographic frustum covering ±20 units in all directions, near 0.5, far 100
- **Bias:** -0.001 (prevents shadow acne — small offset so surfaces don't self-shadow)

### Mesh shadow participation
- Extruded solid meshes (`MeshPhongMaterial`, `flatShading: true`) have both `castShadow = true` and `receiveShadow = true`
- Wireframe overlays (`MeshBasicMaterial`, `wireframe: true`) do not participate in shadows (MeshBasicMaterial ignores lighting)
- Sketch wireframe elements (points, lines, constraints) do not cast or receive shadows

## Scene Background

- **Color:** `0x1a1a2e` (dark navy/charcoal)
