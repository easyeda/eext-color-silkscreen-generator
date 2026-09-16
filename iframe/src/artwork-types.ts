import type { RasterProcessingOptions } from './local-core';

export interface ArtworkPath {
	id: string;
	role: 'hero' | 'flow' | 'accent';
	d: string;
	fill: string;
	stroke: string;
	strokeWidth: number;
	opacity: number;
}

export interface ArtworkSpec {
	version: 1;
	title: string;
	background: string;
	palette: string[];
	paths: ArtworkPath[];
}

export interface RasterArtworkDocument {
	kind: 'raster';
	title: string;
	rawDataUrl: string;
	processedDataUrl: string;
	rawRgba: Uint8ClampedArray;
	mask: Uint8Array;
	mapping: { offsetX: number; offsetY: number; drawWidth: number; drawHeight: number; scale: number };
	seed: number;
	steps: number;
	backend: string;
	processing: RasterProcessingOptions;
	model: { id: string; revision: string; source: 'remote' | 'imported' };
}

export interface VectorArtworkDocument {
	kind: 'vector';
	spec: ArtworkSpec;
	svg: string;
	parameters: { apiUrl: string; model: string; temperature: number; theme: string };
}

export type ArtworkDocument = RasterArtworkDocument | VectorArtworkDocument;
