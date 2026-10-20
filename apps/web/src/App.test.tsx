import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:processed');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function imageResponse() {
  return new Response(new Uint8Array(2048), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'X-Source-Width': '1600',
      'X-Source-Height': '1200',
      'X-Source-Format': 'jpeg',
      'X-Source-Bytes': '524288',
      'X-Cache': 'MISS',
    },
  });
}

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message, requestId: 'req-123' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, url: string) {
  await user.type(screen.getByLabelText('Source image URL'), url);
  await user.type(screen.getByLabelText('Width (px)'), '800');
  await user.type(screen.getByLabelText('Height (px)'), '600');
  await user.selectOptions(screen.getByLabelText('Output format'), 'webp');
  await user.selectOptions(screen.getByLabelText('Crop mode'), 'fill');
  await user.click(screen.getByRole('button', { name: 'Process Image' }));
}

describe('App', () => {
  it('shows the empty state before anything is processed', () => {
    render(<App />);
    expect(screen.getAllByText('Enter an image URL and choose Process Image.')).toHaveLength(2);
    expect(screen.getByLabelText('Crop mode')).toBeDisabled();
    expect(screen.getByLabelText('Quality')).toBeDisabled();
  });

  it('validates locally without calling the API', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Process Image' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a source image URL.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests exactly the displayed URL and shows both images with metadata', async () => {
    fetchMock.mockResolvedValue(imageResponse());
    const user = userEvent.setup();
    render(<App />);
    await fillAndSubmit(user, 'https://images.example.com/cat.jpg');

    const displayed = screen.getByTestId('request-url').textContent;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(displayed);
    expect(displayed).toBe(
      'http://localhost:3000/process?url=https%3A%2F%2Fimages.example.com%2Fcat.jpg&width=800&height=600&format=webp&quality=80&crop=fill',
    );

    const original = (await screen.findByRole('img', { name: 'Original image' })).closest(
      'figure',
    )!;
    expect(original.querySelector('img')).toHaveAttribute(
      'src',
      'https://images.example.com/cat.jpg',
    );
    expect(original.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(within(original).getByText('1600 × 1200')).toBeInTheDocument();
    expect(within(original).getByText('512.0 KB')).toBeInTheDocument();

    const processed = screen.getByRole('img', { name: 'Processed image' }).closest('figure')!;
    expect(within(processed).getByText('webp')).toBeInTheDocument();
    expect(within(processed).getByText('2.0 KB')).toBeInTheDocument();
  });

  it('shows a human-readable message for unsupported images', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(415, 'UNSUPPORTED_IMAGE_TYPE', 'Only JPEG, PNG and WebP sources are accepted.'),
    );
    const user = userEvent.setup();
    render(<App />);
    await fillAndSubmit(user, 'https://images.example.com/anim.gif');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unsupported image');
    expect(alert).toHaveTextContent('Only JPEG, PNG and WebP sources are accepted.');
    expect(alert).toHaveTextContent('req-123');
  });

  it('distinguishes an unreachable source from an unreachable API', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(504, 'UPSTREAM_TIMEOUT', 'The source image took too long to respond.'),
    );
    const user = userEvent.setup();
    render(<App />);
    await fillAndSubmit(user, 'https://slow.example.com/a.jpg');
    expect(await screen.findByRole('alert')).toHaveTextContent('Source timed out');

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Process Image' }));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('copies the curl command and resets the form', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<App />);
    await user.type(screen.getByLabelText('Source image URL'), 'https://e.com/a.jpg');
    await user.click(screen.getByRole('button', { name: 'Copy curl' }));
    expect(writeText).toHaveBeenCalledWith(
      'curl "http://localhost:3000/process?url=https%3A%2F%2Fe.com%2Fa.jpg"',
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Source image URL')).toHaveValue('');
  });

  it('is operable from the keyboard: Enter in the URL field submits', async () => {
    fetchMock.mockResolvedValue(imageResponse());
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Source image URL'), 'https://e.com/a.jpg{Enter}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
