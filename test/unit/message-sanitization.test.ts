import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }

  class LanguageModelToolResultPart {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }

  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  return {
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: LanguageModelToolResultPart,
  };
});

vi.mock('../../src/i18n', () => ({
  t: (message: string) => message,
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));

import * as vscode from 'vscode';
import {
  sanitizeMessagesForModelSwitchDetailed,
  type SanitizedImagePartRetention,
} from '../../src/utils';

const modelId = 'provider/target-model';
const expectedIdentity = 'target-model-identity';

function sanitize(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  imageRetention?: SanitizedImagePartRetention,
) {
  return sanitizeMessagesForModelSwitchDetailed(messages, {
    modelId,
    expectedIdentity,
    imageRetention,
  });
}

function userMessage(
  ...content: vscode.LanguageModelInputPart[]
): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content,
  };
}

function assistantMessage(
  ...content: vscode.LanguageModelInputPart[]
): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    name: undefined,
    content,
  };
}

function textValues(
  message: vscode.LanguageModelChatRequestMessage,
): string[] {
  return message.content.flatMap((part) =>
    part instanceof vscode.LanguageModelTextPart ? [part.value] : [],
  );
}

function createMarker(identity: string): vscode.LanguageModelDataPart {
  const envelope = Buffer.from(
    JSON.stringify({
      identity,
      data: { providerMessage: 'raw' },
    }),
  ).toString('base64');
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${modelId}\\${envelope}`),
    'stateful_marker',
  );
}

function trustedMarker(): vscode.LanguageModelDataPart {
  return createMarker(expectedIdentity);
}

function foreignMarker(): vscode.LanguageModelDataPart {
  return createMarker('other-model-identity');
}

function textPart(value: string): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(value);
}

function imagePart(): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(
    Buffer.from('image-bytes'),
    'image/png',
  );
}

describe('model-switch message sanitization', () => {
  it('keeps a marker-less assistant message without tools intact', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(textPart('answer')),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe(
      vscode.LanguageModelChatMessageRole.Assistant,
    );
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('keeps a marker-less tool exchange intact', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(
        textPart('I will inspect that.'),
        new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
      ),
      userMessage(
        new vscode.LanguageModelToolResultPart('call-1', [textPart('result')]),
      ),
    ]);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].role).toBe(
      vscode.LanguageModelChatMessageRole.Assistant,
    );
    expect(result.messages[2].role).toBe(
      vscode.LanguageModelChatMessageRole.User,
    );
    expect(result.messageOriginIndexes).toEqual([0, 1, 2]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('drops assistant text together with a tool call that carries a foreign marker', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(
        textPart('I will inspect that.'),
        new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
        foreignMarker(),
      ),
      userMessage(
        new vscode.LanguageModelToolResultPart('call-1', [
          textPart('result'),
        ]),
      ),
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe(
      vscode.LanguageModelChatMessageRole.User,
    );
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(result.messageOriginIndexes).toEqual([0]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1, 2]));
  });

  it('keeps an intact tool exchange produced by the target model', () => {
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      userMessage(textPart('question')),
      assistantMessage(
        textPart('I will inspect that.'),
        new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
        trustedMarker(),
      ),
      userMessage(
        new vscode.LanguageModelToolResultPart('call-1', [
          textPart('result'),
        ]),
      ),
    ];

    const result = sanitize(messages);

    expect(result.messages).toEqual(messages);
    expect(result.messageOriginIndexes).toEqual([0, 1, 2]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('drops the tool result when its originating assistant message is sanitized', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(
        textPart('I will inspect that.'),
        new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
        foreignMarker(),
      ),
      userMessage(
        new vscode.LanguageModelToolResultPart('call-1', [textPart('result')]),
      ),
      assistantMessage(textPart('final answer')),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(textValues(result.messages[1])).toEqual(['final answer']);
    expect(result.messageOriginIndexes).toEqual([0, 3]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1, 2]));
  });

  it('drops the originating assistant message when its tool result is sanitized later', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(
        textPart('I will inspect that.'),
        new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
        trustedMarker(),
      ),
      userMessage(
        new vscode.LanguageModelToolResultPart('call-1', [
          textPart('result'),
        ]),
      ),
      assistantMessage(
        textPart('final answer'),
        foreignMarker(),
      ),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(textValues(result.messages[1])).toEqual(['final answer']);
    expect(result.messageOriginIndexes).toEqual([0, 3]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([1, 2, 3]));
  });

  it('sanitizes a round whose assistant message carries multiple markers', () => {
    const result = sanitize([
      userMessage(textPart('question')),
      assistantMessage(
        textPart('answer'),
        trustedMarker(),
        trustedMarker(),
      ),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe(
      vscode.LanguageModelChatMessageRole.Assistant,
    );
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1]));
  });

  it('strips user images from a marker-less round when the target model cannot consume them', () => {
    const result = sanitize(
      [
        userMessage(
          textPart('question'),
          imagePart(),
        ),
        assistantMessage(textPart('answer')),
      ],
      'discard',
    );

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(result.messages[0].content).toHaveLength(1);
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('keeps user images from a marker-less round for a vision capable model', () => {
    const result = sanitize(
      [
        userMessage(
          textPart('question'),
          imagePart(),
        ),
        assistantMessage(textPart('answer')),
      ],
      'user-only',
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toHaveLength(2);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('strips assistant images from a marker-less round for user-only image retention', () => {
    const result = sanitize(
      [
        userMessage(textPart('question')),
        assistantMessage(
          textPart('answer'),
          imagePart(),
        ),
      ],
      'user-only',
    );

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.messages[1].content).toHaveLength(1);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('drops an image-only user message from a marker-less round when images are discarded', () => {
    const result = sanitize(
      [
        userMessage(imagePart()),
        assistantMessage(textPart('answer')),
      ],
      'discard',
    );

    expect(result.messages).toHaveLength(1);
    expect(textValues(result.messages[0])).toEqual(['answer']);
    expect(result.messageOriginIndexes).toEqual([1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('keeps images in a proven round untouched even for a non-vision target model', () => {
    const result = sanitize(
      [
        userMessage(
          textPart('question'),
          imagePart(),
        ),
        assistantMessage(
          textPart('answer'),
          trustedMarker(),
        ),
      ],
      'discard',
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toHaveLength(2);
    expect(result.messages[1].content).toHaveLength(2);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });
});
