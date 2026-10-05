/**
 * Shopify GraphQL Admin API client for Printventory.
 *
 * This module handles communication with the Shopify Admin API to create
 * and update products as Drafts.
 *
 * Supports Client Credentials Grant OAuth flow:
 * POST https://{shop}.myshopify.com/admin/oauth/access_token
 * Content-Type: application/x-www-form-urlencoded
 * Body: grant_type=client_credentials&client_id={id}&client_secret={secret}
 */

const SHOPIFY_API_VERSION = '2024-10';
const REQUEST_TIMEOUT_MS = 30000;

// Cache for access tokens (keyed by storeDomain)
const tokenCache = new Map();

/**
 * Normalize store domain to *.myshopify.com format.
 * @param {string} storeDomain - Input domain (may be custom domain or myshopify.com)
 * @returns {string} Normalized myshopify.com domain
 */
function normalizeStoreDomain(storeDomain) {
  let domain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  // If it's already a myshopify.com domain, return as-is
  if (domain.endsWith('.myshopify.com')) {
    return domain;
  }
  // Otherwise assume it's a custom domain - user must provide the myshopify.com domain
  console.warn(`[Shopify] Domain "${domain}" is not a *.myshopify.com domain. Client Credentials Grant requires the myshopify.com domain.`);
  return domain;
}

/**
 * Build the Shopify GraphQL endpoint URL.
 * @param {string} storeDomain - e.g., 'my-store.myshopify.com'
 * @param {string} apiVersion - e.g., '2024-10'
 * @returns {string} The GraphQL endpoint URL
 */
function buildEndpoint(storeDomain, apiVersion) {
  const domain = normalizeStoreDomain(storeDomain);
  return `https://${domain}/admin/api/${apiVersion || SHOPIFY_API_VERSION}/graphql.json`;
}

/**
 * Build request headers for Shopify API calls.
 * @param {string} accessToken - Shopify Admin API access token
 * @returns {Object} Headers object
 */
function buildHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': accessToken
  };
}

/**
 * Get access token via Client Credentials Grant.
 * @param {string} storeDomain - Must be *.myshopify.com domain
 * @param {string} clientId - Shopify app client ID
 * @param {string} clientSecret - Shopify app client secret
 * @returns {Promise<string>} Access token
 */
async function getAccessToken(storeDomain, clientId, clientSecret) {
  const domain = normalizeStoreDomain(storeDomain);
  const cacheKey = `${domain}:${clientId}`;

  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[Shopify] Using cached access token');
    return cached.token;
  }

  const tokenUrl = `https://${domain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  }).toString();

  console.log('[Shopify] Requesting access token via Client Credentials Grant');
  console.log('[Shopify] POST', tokenUrl);
  console.log('[Shopify] Content-Type: application/x-www-form-urlencoded');
  console.log('[Shopify] Body:', body.replace(clientSecret, '***REDACTED***'));

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const responseText = await response.text();
  console.log('[Shopify] Response status:', response.status, response.statusText);
  console.log('[Shopify] Response body:', responseText);

  if (!response.ok) {
    throw new Error(`Shopify OAuth error: ${response.status} ${response.statusText} - ${responseText}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Shopify OAuth error: Invalid JSON response - ${responseText}`);
  }

  if (!data.access_token) {
    throw new Error(`Shopify OAuth error: No access_token in response - ${responseText}`);
  }

  // Cache the token (expires_in is in seconds, default to 1 hour if not provided)
  const expiresIn = (data.expires_in || 3600) * 1000;
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn - 60000 // Refresh 1 minute early
  });

  console.log('[Shopify] Got access token, expires in', data.expires_in || 3600, 'seconds');
  return data.access_token;
}

/**
 * Clear cached access token for a store.
 * @param {string} storeDomain
 * @param {string} clientId
 */
function clearTokenCache(storeDomain, clientId) {
  const domain = normalizeStoreDomain(storeDomain);
  const cacheKey = `${domain}:${clientId}`;
  tokenCache.delete(cacheKey);
}

/**
 * Execute a GraphQL request against the Shopify Admin API.
 * @param {string} storeDomain
 * @param {string} accessToken
 * @param {string} query - GraphQL query or mutation
 * @param {Object} variables - Query variables
 * @returns {Promise<Object>} The response data
 */
async function graphqlRequest(storeDomain, accessToken, query, variables = {}) {
  const endpoint = buildEndpoint(storeDomain);

  console.log('[Shopify] GraphQL request to:', endpoint);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(accessToken),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[Shopify] GraphQL error response:', response.status, text);
    throw new Error(`Shopify API error: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  if (data.errors) {
    console.error('[Shopify] GraphQL errors:', JSON.stringify(data.errors));
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

/**
 * Test connection to Shopify API using Client Credentials Grant.
 * @param {string} storeDomain - Must be *.myshopify.com domain
 * @param {string} clientId - Shopify app client ID
 * @param {string} clientSecret - Shopify app client secret
 * @returns {Promise<{ok: boolean, shopName: string, currency: string}>}
 */
async function testConnection(storeDomain, clientId, clientSecret) {
  // First, get an access token
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  // Then test the GraphQL API
  const query = `{ shop { name currencyCode } }`;
  const data = await graphqlRequest(storeDomain, accessToken, query);
  return {
    ok: true,
    shopName: data.shop.name,
    currency: data.shop.currencyCode
  };
}

/**
 * Test connection with a direct access token (legacy method).
 * @param {string} storeDomain
 * @param {string} accessToken - Pre-existing access token (shpat_...)
 * @returns {Promise<{ok: boolean, shopName: string, currency: string}>}
 */
async function testConnectionWithToken(storeDomain, accessToken) {
  const query = `{ shop { name currencyCode } }`;
  const data = await graphqlRequest(storeDomain, accessToken, query);
  return {
    ok: true,
    shopName: data.shop.name,
    currency: data.shop.currencyCode
  };
}

/**
 * Create a product as Draft in Shopify.
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {Object} product - Product data
 * @returns {Promise<{productId: string, variantId: string}>}
 */
async function createProductDraft(storeDomain, clientId, clientSecret, product) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);
  const mutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          status
          variants(first: 1) {
            edges { node { id sku } }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const input = {
    title: product.title,
    descriptionHtml: product.description || '',
    status: 'DRAFT',
    vendor: product.licensor_collection || undefined,
    tags: product.tags || []
  };

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { input });

  if (data.productCreate.userErrors?.length > 0) {
    throw new Error(data.productCreate.userErrors.map(e => e.message).join('; '));
  }

  return {
    productId: data.productCreate.product.id,
    variantId: data.productCreate.product.variants.edges[0]?.node.id
  };
}

/**
 * Update an existing product in Shopify.
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID
 * @param {Object} updates - Fields to update
 * @returns {Promise<{success: boolean}>}
 */
async function updateProduct(storeDomain, clientId, clientSecret, productId, updates) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id title status }
        userErrors { field message }
      }
    }
  `;

  const input = {
    id: productId,
    title: updates.title,
    descriptionHtml: updates.description || '',
    vendor: updates.licensor_collection || undefined,
    tags: updates.tags || []
  };

  // Add SEO fields if provided
  if (updates.seo && (updates.seo.title || updates.seo.description)) {
    input.seo = {};
    if (updates.seo.title) input.seo.title = updates.seo.title;
    if (updates.seo.description) input.seo.description = updates.seo.description;
  }

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { input });

  if (data.productUpdate.userErrors?.length > 0) {
    throw new Error(data.productUpdate.userErrors.map(e => e.message).join('; '));
  }

  return { success: true };
}

/**
 * Update multiple variants using productVariantsBulkUpdate (2024-10 API).
 * This replaces the deprecated productVariantUpdate mutation.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID (required for bulk update)
 * @param {Array<{id: string, price?: number, sku?: string, compareAtPrice?: number}>} variants - Array of variant updates
 * @returns {Promise<{success: boolean, variants: Array}>}
 */
async function updateVariantsBulk(storeDomain, clientId, clientSecret, productId, variants) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id }
        productVariants {
          id
          price
          compareAtPrice
          inventoryItem { sku }
        }
        userErrors { field message }
      }
    }
  `;

  // Transform variants to the bulk input format
  // Note: SKU is nested under inventoryItem in the new API
  const variantInputs = variants.map(v => {
    const input = { id: v.id };
    if (v.price != null) {
      input.price = String(v.price);
    }
    if (v.compareAtPrice != null) {
      input.compareAtPrice = String(v.compareAtPrice);
    }
    if (v.sku != null) {
      input.inventoryItem = { sku: v.sku };
    }
    return input;
  });

  console.log('[Shopify] productVariantsBulkUpdate for product:', productId);
  console.log('[Shopify] Variants to update:', JSON.stringify(variantInputs, null, 2));

  const data = await graphqlRequest(storeDomain, accessToken, mutation, {
    productId,
    variants: variantInputs
  });

  if (data.productVariantsBulkUpdate.userErrors?.length > 0) {
    const errors = data.productVariantsBulkUpdate.userErrors;
    console.error('[Shopify] productVariantsBulkUpdate errors:', errors);
    throw new Error(errors.map(e => `${e.field}: ${e.message}`).join('; '));
  }

  return {
    success: true,
    variants: data.productVariantsBulkUpdate.productVariants || []
  };
}

/**
 * Update a single variant's price and SKU.
 * Convenience wrapper around updateVariantsBulk for single-variant updates.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID
 * @param {string} variantId - Shopify variant GID
 * @param {number} price
 * @param {string} sku
 * @returns {Promise<{success: boolean}>}
 */
async function updateVariant(storeDomain, clientId, clientSecret, productId, variantId, price, sku) {
  return updateVariantsBulk(storeDomain, clientId, clientSecret, productId, [
    { id: variantId, price, sku }
  ]);
}

/**
 * Fetch a single Shopify product with all its variants.
 * Used during reconciliation to pull in existing variant data.
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productGid - Shopify product GID (e.g., "gid://shopify/Product/123")
 * @returns {Promise<Object>} Product with variants array
 */
async function fetchProductWithVariants(storeDomain, clientId, clientSecret, productGid) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const query = `
    query getProduct($id: ID!) {
      product(id: $id) {
        id
        title
        descriptionHtml
        vendor
        status
        tags
        seo {
          title
          description
        }
        options {
          name
          values
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions {
                name
                value
              }
            }
          }
        }
        media(first: 50) {
          edges {
            node {
              id
              alt
              mediaContentType
              ... on MediaImage {
                id
                image {
                  url
                  altText
                  width
                  height
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(storeDomain, accessToken, query, { id: productGid });

  if (!data.product) {
    throw new Error(`Product not found: ${productGid}`);
  }

  const product = data.product;

  // Transform variants into a flat array
  const variants = (product.variants?.edges || []).map(edge => {
    const v = edge.node;
    // Get the first option value (most products have just one option like "Finish")
    const optionValue = v.selectedOptions?.[0]?.value || v.title || 'Default';
    return {
      id: v.id,
      title: v.title,
      optionValue: optionValue,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryQuantity: v.inventoryQuantity
    };
  });

  // Transform media into a flat array
  const media = (product.media?.edges || []).map(edge => {
    const m = edge.node;
    return {
      id: m.id,
      alt: m.alt,
      mediaContentType: m.mediaContentType,
      url: m.image?.url || null,
      altText: m.image?.altText || m.alt,
      width: m.image?.width,
      height: m.image?.height
    };
  }).filter(m => m.mediaContentType === 'IMAGE'); // Only images for now

  return {
    id: product.id,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    status: product.status,
    tags: product.tags || [],
    seo: product.seo || { title: null, description: null },
    options: product.options,
    variants: variants,
    media: media
  };
}

/**
 * Create staged upload URLs for images.
 * This is the first step in uploading images to Shopify.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {Array<{filename: string, mimeType: string, fileSize: number}>} files
 * @returns {Promise<Array<{url: string, parameters: Array, resourceUrl: string}>>}
 */
async function createStagedUploads(storeDomain, clientId, clientSecret, files) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = files.map(f => ({
    filename: f.filename,
    mimeType: f.mimeType,
    fileSize: String(f.fileSize),
    resource: 'IMAGE',
    httpMethod: 'POST'
  }));

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { input });

  if (data.stagedUploadsCreate.userErrors?.length > 0) {
    throw new Error(data.stagedUploadsCreate.userErrors.map(e => e.message).join('; '));
  }

  return data.stagedUploadsCreate.stagedTargets;
}

/**
 * Add images to a product using productCreateMedia.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID
 * @param {Array<{originalSource: string, alt?: string}>} mediaInputs - Array of media to create
 * @returns {Promise<{success: boolean, media: Array}>}
 */
async function createProductMedia(storeDomain, clientId, clientSecret, productId, mediaInputs) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const mutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          id
          alt
          mediaContentType
          status
          ... on MediaImage {
            image {
              url
            }
          }
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  const media = mediaInputs.map(m => ({
    originalSource: m.originalSource,
    alt: m.alt || '',
    mediaContentType: 'IMAGE'
  }));

  console.log('[Shopify] productCreateMedia for product:', productId);
  console.log('[Shopify] Media to create:', media.length);

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { productId, media });

  if (data.productCreateMedia.mediaUserErrors?.length > 0) {
    const errors = data.productCreateMedia.mediaUserErrors;
    console.error('[Shopify] productCreateMedia errors:', errors);
    throw new Error(errors.map(e => `${e.field}: ${e.message}`).join('; '));
  }

  return {
    success: true,
    media: data.productCreateMedia.media || []
  };
}

/**
 * Delete media from a product.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID
 * @param {Array<string>} mediaIds - Array of media GIDs to delete
 * @returns {Promise<{success: boolean, deletedIds: Array}>}
 */
async function deleteProductMedia(storeDomain, clientId, clientSecret, productId, mediaIds) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const mutation = `
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  console.log('[Shopify] productDeleteMedia for product:', productId);
  console.log('[Shopify] Media IDs to delete:', mediaIds);

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { productId, mediaIds });

  if (data.productDeleteMedia.mediaUserErrors?.length > 0) {
    const errors = data.productDeleteMedia.mediaUserErrors;

    // "Media ids ... do not exist" means the photo is already gone from
    // Shopify - exactly the end state a delete was trying to reach, so
    // treat it as a no-op rather than a failure. Seen in practice when the
    // local photo baseline is stale (e.g. a prior push's delete step
    // succeeded but a LATER step in that same push failed, so the overall
    // push reported failure and never got to refreshLiveShopifyData() to
    // reset the baseline - the next push then retries deleting media that
    // is already deleted). A genuinely different error (permissions, the
    // product's last image, etc.) still throws as before.
    const alreadyGoneErrors = errors.filter(e => /do not exist/i.test(e.message || ''));
    const otherErrors = errors.filter(e => !/do not exist/i.test(e.message || ''));

    if (alreadyGoneErrors.length > 0) {
      console.warn('[Shopify] productDeleteMedia: some media IDs were already gone (not treated as a failure):', alreadyGoneErrors);
    }
    if (otherErrors.length > 0) {
      console.error('[Shopify] productDeleteMedia errors:', otherErrors);
      throw new Error(otherErrors.map(e => `${e.field}: ${e.message}`).join('; '));
    }
  }

  return {
    success: true,
    // Shopify only lists IDs it actually deleted this call in
    // deletedMediaIds - if everything requested was already gone (so
    // nothing needed deleting), fall back to the full requested list so the
    // caller still sees its target state achieved.
    deletedIds: data.productDeleteMedia.deletedMediaIds?.length ? data.productDeleteMedia.deletedMediaIds : mediaIds
  };
}

/**
 * Reorder media on a product.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId - Shopify product GID
 * @param {Array<{id: string, newPosition: number}>} moves - Array of media ID + position pairs
 * @returns {Promise<{success: boolean}>}
 */
async function reorderProductMedia(storeDomain, clientId, clientSecret, productId, moves) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const mutation = `
    mutation productReorderMedia($productId: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $productId, moves: $moves) {
        job {
          id
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  console.log('[Shopify] productReorderMedia for product:', productId);
  console.log('[Shopify] Moves:', moves);

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { productId, moves });

  if (data.productReorderMedia.mediaUserErrors?.length > 0) {
    const errors = data.productReorderMedia.mediaUserErrors;
    console.error('[Shopify] productReorderMedia errors:', errors);
    throw new Error(errors.map(e => `${e.field}: ${e.message}`).join('; '));
  }

  return { success: true };
}

/**
 * Upload images to a product using staged uploads.
 * This is a multi-step process:
 * 1. Create staged upload targets
 * 2. Upload files to the staged URLs
 * 3. Attach the uploaded images to the product
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} productId
 * @param {Array<{filename: string, data: Buffer, mimeType: string}>} images
 * @returns {Promise<{success: boolean, count: number}>}
 */
async function uploadProductImages(storeDomain, clientId, clientSecret, productId, images) {
  if (!images || images.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    // Step 1: Create staged upload targets
    const fileInfos = images.map(img => ({
      filename: img.filename,
      mimeType: img.mimeType || 'image/jpeg',
      fileSize: img.data.length
    }));

    const stagedTargets = await createStagedUploads(storeDomain, clientId, clientSecret, fileInfos);

    // Step 2: Upload files to staged URLs
    const resourceUrls = [];
    for (let i = 0; i < images.length; i++) {
      const target = stagedTargets[i];
      const image = images[i];

      // Build form data with parameters
      const formData = new FormData();
      for (const param of target.parameters) {
        formData.append(param.name, param.value);
      }
      formData.append('file', new Blob([image.data], { type: image.mimeType }), image.filename);

      // Upload to staged URL
      const uploadResponse = await fetch(target.url, {
        method: 'POST',
        body: formData
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed for ${image.filename}: ${uploadResponse.status}`);
      }

      resourceUrls.push(target.resourceUrl);
    }

    // Step 3: Attach to product using productCreateMedia
    const mediaInputs = resourceUrls.map((url, idx) => ({
      originalSource: url,
      alt: images[idx].alt || ''
    }));

    await createProductMedia(storeDomain, clientId, clientSecret, productId, mediaInputs);

    return { success: true, count: images.length };
  } catch (error) {
    console.error('[Shopify] uploadProductImages error:', error);
    throw error;
  }
}

/**
 * Get the shop's primary location ID.
 * Most single-location shops only have one location.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<string>} Location GID
 */
async function getPrimaryLocationId(storeDomain, clientId, clientSecret) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const query = `
    query getLocations {
      locations(first: 1) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(storeDomain, accessToken, query);
  const location = data.locations?.edges?.[0]?.node;

  if (!location) {
    throw new Error('No locations found for this shop');
  }

  console.log('[Shopify] Primary location:', location.name, location.id);
  return location.id;
}

/**
 * Get the inventory item ID for a variant.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} variantId - Shopify variant GID
 * @returns {Promise<string>} Inventory item GID
 */
async function getInventoryItemId(storeDomain, clientId, clientSecret, variantId) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const query = `
    query getVariantInventory($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
        }
      }
    }
  `;

  const data = await graphqlRequest(storeDomain, accessToken, query, { id: variantId });

  if (!data.productVariant?.inventoryItem?.id) {
    throw new Error(`No inventory item found for variant: ${variantId}`);
  }

  return data.productVariant.inventoryItem.id;
}

/**
 * Set inventory quantities using inventorySetQuantities mutation.
 * This is the 2024-10 API method for updating inventory levels.
 *
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {Array<{variantId: string, quantity: number}>} updates - Array of variant ID + quantity pairs
 * @returns {Promise<{success: boolean, results: Array}>}
 */
async function setInventoryQuantities(storeDomain, clientId, clientSecret, updates) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  // Get the primary location
  const locationId = await getPrimaryLocationId(storeDomain, clientId, clientSecret);

  // Get inventory item IDs for each variant
  const quantities = [];
  for (const update of updates) {
    const inventoryItemId = await getInventoryItemId(storeDomain, clientId, clientSecret, update.variantId);
    quantities.push({
      inventoryItemId,
      locationId,
      quantity: update.quantity
    });
  }

  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          id
          reason
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    name: 'available',
    reason: 'correction',
    ignoreCompareQuantity: true,
    quantities: quantities
  };

  console.log('[Shopify] inventorySetQuantities:', JSON.stringify(input, null, 2));

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { input });

  if (data.inventorySetQuantities.userErrors?.length > 0) {
    const errors = data.inventorySetQuantities.userErrors;
    console.error('[Shopify] inventorySetQuantities errors:', errors);
    throw new Error(errors.map(e => `${e.field}: ${e.message}`).join('; '));
  }

  console.log('[Shopify] Inventory updated successfully');
  return {
    success: true,
    adjustmentGroupId: data.inventorySetQuantities.inventoryAdjustmentGroup?.id
  };
}

/**
 * Fetch all products from Shopify (paginated).
 * @param {string} storeDomain
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {number} limit - Max products to fetch (default 250)
 * @param {string} sortKey - Sort key: TITLE, CREATED_AT, UPDATED_AT, etc. Default TITLE
 * @returns {Promise<Array>} List of products with id, title, status
 */
async function fetchAllProducts(storeDomain, clientId, clientSecret, limit = 250, sortKey = 'TITLE') {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);
  const query = `
    query getProducts($first: Int!, $after: String, $sortKey: ProductSortKeys) {
      products(first: $first, after: $after, sortKey: $sortKey) {
        edges {
          node {
            id
            title
            status
            handle
            vendor
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                  price
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage && allProducts.length < limit) {
    const batchSize = Math.min(50, limit - allProducts.length);
    const data = await graphqlRequest(storeDomain, accessToken, query, {
      first: batchSize,
      after: cursor,
      sortKey: sortKey
    });

    const edges = data.products?.edges || [];
    for (const edge of edges) {
      const node = edge.node;
      allProducts.push({
        id: node.id,
        title: node.title,
        status: node.status,
        handle: node.handle,
        vendor: node.vendor,
        variantId: node.variants?.edges?.[0]?.node?.id,
        sku: node.variants?.edges?.[0]?.node?.sku,
        price: node.variants?.edges?.[0]?.node?.price
      });
      cursor = edge.cursor;
    }

    hasNextPage = data.products?.pageInfo?.hasNextPage && allProducts.length < limit;
  }

  return allProducts;
}

/**
 * Fetch orders from Shopify (GR-PLAN-006 order sync).
 *
 * Defaults to open, not-yet-fully-fulfilled orders (unfulfilled or partially
 * fulfilled) sorted oldest-first - that's the natural FIFO queue for "what
 * should I print next." Pass a custom `searchQuery` to widen/narrow scope
 * (e.g. null/'' to fetch everything, for a one-off full resync).
 *
 * Requires the `read_orders` scope on the custom app - this call will fail
 * with an access-denied style GraphQL error until that scope is added in
 * the Shopify Partner/Dev Dashboard (see GR-PLAN-006 prerequisites).
 */
async function fetchOrders(storeDomain, clientId, clientSecret, options = {}) {
  const {
    searchQuery = 'fulfillment_status:unfulfilled OR fulfillment_status:partial',
    limit = 250
  } = options;

  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);
  const query = `
    query getOrders($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: false) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              firstName
              lastName
            }
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  variantTitle
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  image {
                    url
                  }
                  variant {
                    id
                    sku
                    product {
                      id
                    }
                  }
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const allOrders = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage && allOrders.length < limit) {
    const batchSize = Math.min(50, limit - allOrders.length);
    const data = await graphqlRequest(storeDomain, accessToken, query, {
      first: batchSize,
      after: cursor,
      query: searchQuery || null
    });

    const edges = data.orders?.edges || [];
    for (const edge of edges) {
      const node = edge.node;
      const lineItems = (node.lineItems?.edges || []).map(liEdge => {
        const li = liEdge.node;
        return {
          id: li.id,
          title: li.title,
          quantity: li.quantity,
          sku: li.sku || li.variant?.sku || null,
          variantId: li.variant?.id || null,
          // GR-PLAN-006: the parent Shopify PRODUCT gid, used as a fallback
          // match when the specific variant/SKU has no shopify_variants row
          // of its own (e.g. a "complete set" bundle SKU) but the product
          // itself is linked in Printventory - lets the Orders pane offer
          // "Open Product Manager" instead of silently guessing a file.
          productGid: li.variant?.product?.id || null,
          variantTitle: li.variantTitle || null,
          unitPrice: li.originalUnitPriceSet?.shopMoney?.amount || null,
          unitPriceCurrency: li.originalUnitPriceSet?.shopMoney?.currencyCode || null,
          imageUrl: li.image?.url || null
        };
      });
      allOrders.push({
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        customerName: [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(' ') || null,
        totalAmount: node.totalPriceSet?.shopMoney?.amount || null,
        totalCurrency: node.totalPriceSet?.shopMoney?.currencyCode || null,
        lineItems
      });
      cursor = edge.cursor;
    }

    hasNextPage = data.orders?.pageInfo?.hasNextPage && allOrders.length < limit;
  }

  return allOrders;
}

/**
 * Fetch the order's open fulfillment order (GR-PLAN-006 Phase B fulfillment
 * push). A self-fulfilled, single-location shop normally has exactly one
 * fulfillable FulfillmentOrder per order; returns the first OPEN one (or
 * the first of whatever comes back, so a genuinely unusual state still
 * surfaces a real Shopify error from fulfillmentCreateV2 rather than a
 * silent no-op here).
 */
async function fetchFulfillmentOrderForOrder(storeDomain, clientId, clientSecret, orderGid) {
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const query = `
    query getOrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 5) {
          edges {
            node {
              id
              status
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(storeDomain, accessToken, query, { id: orderGid });
  const nodes = (data.order?.fulfillmentOrders?.edges || []).map((e) => e.node);
  const open = nodes.find((n) => n.status === 'OPEN') || nodes[0];

  if (!open) {
    throw new Error('No fulfillment order found for this order - it may already be fully fulfilled, or its data has not synced from Shopify yet.');
  }

  return open.id;
}

/**
 * Create a fulfillment for a FulfillmentOrder using the current
 * fulfillmentCreateV2 mutation - the legacy fulfillmentCreate mutation is
 * deprecated, same shape of change GR-PLAN-004 already made for
 * productVariantUpdate -> productVariantsBulkUpdate. Omitting
 * fulfillmentOrderLineItems fulfills the fulfillment order's entire
 * remaining fulfillable quantity, matching James's own described workflow
 * (shipping generated once per order, not itemized per line).
 *
 * @param {object} args
 * @param {string} args.fulfillmentOrderId
 * @param {string} [args.trackingNumber]
 * @param {string} [args.trackingCompany] - matched against Shopify's own
 *   internal carrier list to auto-generate the customer's tracking link; no
 *   carrier API/account connection involved (see GR-PLAN-006).
 * @param {string} [args.trackingUrl] - only meaningful for an
 *   unrecognized/free-text carrier; Shopify auto-generates it otherwise.
 * @param {boolean} [args.notifyCustomer=true]
 */
async function createFulfillment(storeDomain, clientId, clientSecret, args) {
  const { fulfillmentOrderId, trackingNumber, trackingCompany, trackingUrl, notifyCustomer = true } = args || {};
  const accessToken = await getAccessToken(storeDomain, clientId, clientSecret);

  const mutation = `
    mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo {
            number
            url
            company
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const trackingInfo = trackingNumber ? {
    number: trackingNumber,
    company: trackingCompany || null,
    url: trackingUrl || null
  } : undefined;

  const input = {
    lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
    notifyCustomer,
    ...(trackingInfo ? { trackingInfo } : {})
  };

  console.log('[Shopify] fulfillmentCreateV2:', JSON.stringify(input, null, 2));

  const data = await graphqlRequest(storeDomain, accessToken, mutation, { fulfillment: input });
  const errors = data.fulfillmentCreateV2?.userErrors;
  if (errors?.length > 0) {
    console.error('[Shopify] fulfillmentCreateV2 errors:', errors);
    throw new Error(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  }

  console.log('[Shopify] Fulfillment created:', data.fulfillmentCreateV2.fulfillment?.id);
  return data.fulfillmentCreateV2.fulfillment;
}

module.exports = {
  SHOPIFY_API_VERSION,
  buildEndpoint,
  normalizeStoreDomain,
  getAccessToken,
  clearTokenCache,
  testConnection,
  testConnectionWithToken,
  createProductDraft,
  updateProduct,
  updateVariant,
  updateVariantsBulk,
  fetchProductWithVariants,
  createStagedUploads,
  createProductMedia,
  deleteProductMedia,
  reorderProductMedia,
  uploadProductImages,
  fetchAllProducts,
  fetchOrders,
  fetchFulfillmentOrderForOrder,
  createFulfillment,
  graphqlRequest,
  getPrimaryLocationId,
  getInventoryItemId,
  setInventoryQuantities
};
