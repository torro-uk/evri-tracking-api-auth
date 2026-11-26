export const text = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });

export function proofContent(result) {
  const { images, ...metadata } = result;
  const proof = images.map(({ data, ...fields }) => fields);
  return { content: [text({ ...metadata, imageCount: images.length, images: proof }),
    ...images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))] };
}

