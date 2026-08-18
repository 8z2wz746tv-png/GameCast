export function resolveNativeOutputIndex(
  sourceId: string,
  mappedOutputIndex?: number,
): number | undefined {
  if (Number.isInteger(mappedOutputIndex) && mappedOutputIndex! >= 0) {
    return mappedOutputIndex;
  }
  const match = /^screen:(\d+):/.exec(sourceId);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export type NativePreviewFrame = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

export type ElectronScreenPreview = NativePreviewFrame & {
  sourceId: string;
};

export type DxgiOutputPreview = NativePreviewFrame & {
  outputIndex: number;
};

export type NativeOutputCalibration = {
  reliable: boolean;
  averageDistance: number;
  assignmentMargin: number;
  matches: Array<{
    sourceId: string;
    outputIndex: number;
    distance: number;
  }>;
  probeErrors?: string[];
};

const SIGNATURE_COLUMNS = 16;
const SIGNATURE_ROWS = 9;

export function matchNativeOutputPreviews(
  screens: ElectronScreenPreview[],
  outputs: DxgiOutputPreview[],
): NativeOutputCalibration {
  if (
    screens.length === 0 ||
    outputs.length === 0 ||
    outputs.length > screens.length ||
    screens.length > 8
  ) {
    return emptyCalibration();
  }

  const screenSignatures = screens.map(createPreviewSignature);
  const outputSignatures = outputs.map(createPreviewSignature);
  if (screenSignatures.some((value) => !value) || outputSignatures.some((value) => !value)) {
    return emptyCalibration();
  }

  const distances = outputSignatures.map((output) =>
    screenSignatures.map((screen) => signatureDistance(output!, screen!)),
  );
  let bestScore = Number.POSITIVE_INFINITY;
  let secondScore = Number.POSITIVE_INFINITY;
  let bestAssignment: number[] | undefined;

  const visit = (outputPosition: number, used: Set<number>, assignment: number[], score: number) => {
    if (score >= secondScore) return;
    if (outputPosition === outputs.length) {
      if (score < bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestAssignment = [...assignment];
      } else if (score < secondScore) {
        secondScore = score;
      }
      return;
    }
    for (let screenPosition = 0; screenPosition < screens.length; screenPosition += 1) {
      if (used.has(screenPosition)) continue;
      used.add(screenPosition);
      assignment.push(screenPosition);
      visit(
        outputPosition + 1,
        used,
        assignment,
        score + distances[outputPosition]![screenPosition]!,
      );
      assignment.pop();
      used.delete(screenPosition);
    }
  };
  visit(0, new Set(), [], 0);
  if (!bestAssignment) return emptyCalibration();

  const matches = bestAssignment
    .map((screenPosition, outputPosition) => ({
      sourceId: screens[screenPosition]!.sourceId,
      outputIndex: outputs[outputPosition]!.outputIndex,
      distance: roundDistance(distances[outputPosition]![screenPosition]!),
      screenPosition,
    }))
    .sort((left, right) => left.screenPosition - right.screenPosition)
    .map(({ screenPosition: _screenPosition, ...match }) => match);
  const averageDistance = bestScore / outputs.length;
  const assignmentMargin = Number.isFinite(secondScore)
    ? (secondScore - bestScore) / outputs.length
    : Number.POSITIVE_INFINITY;
  return {
    reliable: averageDistance <= 55 && assignmentMargin >= 2.5,
    averageDistance: roundDistance(averageDistance),
    assignmentMargin: roundDistance(assignmentMargin),
    matches,
  };
}

function createPreviewSignature(frame: NativePreviewFrame): number[] | undefined {
  const { width, height, pixels } = frame;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels.byteLength < width * height * 4
  ) {
    return undefined;
  }
  const result: number[] = [];
  for (let row = 0; row < SIGNATURE_ROWS; row += 1) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / SIGNATURE_ROWS));
    for (let column = 0; column < SIGNATURE_COLUMNS; column += 1) {
      const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / SIGNATURE_COLUMNS));
      const offset = (y * width + x) * 4;
      result.push(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!);
    }
  }
  return result;
}

function signatureDistance(left: number[], right: number[]): number {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index]! - right[index]!);
  }
  return difference / left.length;
}

function emptyCalibration(): NativeOutputCalibration {
  return {
    reliable: false,
    averageDistance: 255,
    assignmentMargin: 0,
    matches: [],
  };
}

function roundDistance(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}
