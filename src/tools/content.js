export const text = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });

export function proofContent(result, links = null) {
  const { images, ...metadata } = result;
  const proof = images.map(({ data, ...fields }, index) => ({ ...fields, ...(links ? links.issue(result, images[index]) : {}) }));
  return { content: [text({ ...metadata, imageCount: images.length, images: proof }),
    ...images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))] };
}

