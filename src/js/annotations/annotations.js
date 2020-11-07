/**
 * @fileoverview Methods for ideogram annotations.
 * Annotations are graphical objects that represent features of interest
 * located on the chromosomes, e.g. genes or variations.  They can
 * appear beside a chromosome, overlaid on top of it, or between multiple
 * chromosomes.
 */

import {BedParser} from '../parsers/bed-parser';
import {drawHeatmaps, deserializeAnnotsForHeatmap} from './heatmap';
import {inflateThresholds} from './heatmap-lib';
import {inflateHeatmaps} from './heatmap-collinear';
import {
  onLoadAnnots, onDrawAnnots, startHideAnnotTooltipTimeout,
  onWillShowAnnotTooltip, showAnnotTooltip, onClickAnnot
} from './events';

import {
  addAnnotLabel, removeAnnotLabel, fillAnnotLabels, clearAnnotLabels
  // fadeOutAnnotLabels
} from './labels';

import {drawAnnots, drawProcessedAnnots} from './draw';
import {getHistogramBars} from './histogram';
import {drawSynteny} from './synteny';
import {
  restoreDefaultTracks, setOriginalTrackIndexes, updateDisplayedTracks
} from './filter';
import {processAnnotData} from './process';
import {ExpressionMatrixParser} from '../parsers/expression-matrix-parser';
import {downloadAnnotations} from './download';

function initNumTracksAndBarWidth(ideo, config) {

  if (config.annotationTracks) {
    ideo.config.numAnnotTracks = config.annotationTracks.length;
  } else if (config.annotationsNumTracks) {
    ideo.config.numAnnotTracks = config.annotationsNumTracks;
  } else {
    ideo.config.numAnnotTracks = 1;
  }
  ideo.config.annotTracksHeight =
    config.annotationHeight * config.numAnnotTracks;

  if (typeof config.barWidth === 'undefined') {
    ideo.config.barWidth = 3;
  }
}

function initTooltip(ideo, config) {
  if (config.showAnnotTooltip !== false) {
    ideo.config.showAnnotTooltip = true;
  }

  if (config.onWillShowAnnotTooltip) {
    ideo.onWillShowAnnotTooltipCallback = config.onWillShowAnnotTooltip;
  }
}

function initAnnotLabel(ideo, config) {
  if (config.addAnnotLabel !== false) {
    ideo.config.addAnnotLabel = true;
  }

  if (config.onWillAddAnnotLabel) {
    ideo.onWillAddAnnotLabelCallback = config.onWillAddAnnotLabel;
  }
}

function initAnnotHeight(ideo) {
  var config = ideo.config;
  var annotHeight;

  if (!config.annotationHeight) {
    if (config.annotationsLayout === 'heatmap') {
      annotHeight = config.chrWidth - 1;
    } else {
      annotHeight = Math.round(config.chrHeight / 100);
      if (annotHeight < 3) annotHeight = 3;
    }
    ideo.config.annotationHeight = annotHeight;
  }
}

/**
 * Initializes various annotation settings.  Constructor help function.
 */
function initAnnotSettings() {
  var ideo = this,
    config = ideo.config;

  initAnnotHeight(ideo);

  if (
    config.annotationsPath || config.localAnnotationsPath ||
    ideo.annots || config.annotations
  ) {
    initNumTracksAndBarWidth(ideo, config);
  } else {
    ideo.config.annotTracksHeight = 0;
    ideo.config.numAnnotTracks = 0;
  }

  if (typeof config.annotationsColor === 'undefined') {
    ideo.config.annotationsColor = '#F00';
  }

  if (config.onClickAnnot) {
    ideo.onClickAnnotCallback = config.onClickAnnot;
  }

  initTooltip(ideo, config);
  initAnnotLabel(ideo, config);
}

function validateAnnotsUrl(annotsUrl) {
  var tmp, extension;

  tmp = annotsUrl.split('?')[0].split('.');
  extension = tmp[tmp.length - 1];

  if (extension !== 'bed' && extension !== 'json') {
    extension = extension.toUpperCase();
    alert(
      'Ideogram.js only supports BED and Ideogram JSON at the moment.  ' +
      'Sorry, check back soon for ' + extension + ' support!'
    );
    return;
  }
  return extension;
}

/** Find redundant chromosomes in raw annotations */
function detectDuplicateChrsInRawAnnots(ideo) {
  const seen = {};
  const duplicates = [];
  const chrs = ideo.rawAnnots.annots.map(annot => annot.chr);

  chrs.forEach((chr) => {
    if (chr in seen) duplicates.push(chr);
    seen[chr] = 1;
  });

  if (duplicates.length > 0) {
    const message =
      `Duplicate chromosomes detected.\n` +
      `Chromosome list: ${chrs}.  Duplicates: ${duplicates}.\n` +
      `To fix this, edit your raw annotations JSON data to remove redundant ` +
      `chromosomes.`;
    throw Error(message);
  }
}

function afterRawAnnots() {
  var ideo = this,
    config = ideo.config;

  // Ensure annots are ordered by chromosome
  ideo.rawAnnots.annots = ideo.rawAnnots.annots.sort(Ideogram.sortChromosomes);

  if (ideo.onLoadAnnotsCallback) {
    ideo.onLoadAnnotsCallback();
  }

  if (
    'heatmapThresholds' in config ||
    'metadata' in ideo.rawAnnots &&
    'heatmapThresholds' in ideo.rawAnnots.metadata
  ) {
    if (config.annotationsLayout === 'heatmap') {
      inflateHeatmaps(ideo);
    } else if (config.annotationsLayout === 'heatmap-2d') {
      ideo.config.heatmapThresholds = inflateThresholds(ideo);
    }
  }

  if (config.heatmaps) {
    ideo.deserializeAnnotsForHeatmap(ideo.rawAnnots);
  }

  detectDuplicateChrsInRawAnnots(ideo);
}

/**
 * Requests annotations URL via HTTP, sets ideo.rawAnnots for downstream
 * processing.
 *
 * @param annotsUrl Absolute or relative URL for native or BED annotations file
 */
function fetchAnnots(annotsUrl) {
  var extension, is2dHeatmap,
    ideo = this,
    config = ideo.config;

  is2dHeatmap = config.annotationsLayout === 'heatmap-2d';

  if (annotsUrl.slice(0, 4) !== 'http' && !is2dHeatmap) {
    ideo.fetch(annotsUrl)
      .then(function(data) {
        ideo.rawAnnotsResponse = data; // Preserve truly raw response content
        ideo.rawAnnots = data; // Sometimes gets partially processed
        ideo.afterRawAnnots();
      });
    return;
  }

  extension = (is2dHeatmap ? '' : validateAnnotsUrl(annotsUrl));

  ideo.fetch(annotsUrl, 'text')
    .then(function(text) {
      ideo.rawAnnotsResponse = text;
      if (is2dHeatmap) {
        var parser = new ExpressionMatrixParser(text, ideo);
        parser.setRawAnnots().then(function(d) {
          ideo.rawAnnots = d;
          ideo.afterRawAnnots();
        });
      } else {
        if (extension === 'bed') {
          ideo.rawAnnots = new BedParser(text, ideo).rawAnnots;
        } else {
          ideo.rawAnnots = JSON.parse(text);
        }
        ideo.afterRawAnnots();
      }
    });
}

/**
 * Fills out annotations data structure such that its top-level list of arrays
 * matches that of this ideogram's chromosomes list in order and number
 * Fixes https://github.com/eweitz/ideogram/issues/66
 */
function fillAnnots(annots) {
  var filledAnnots, chrs, chrArray, i, chr, annot, chrIndex;

  filledAnnots = [];
  chrs = [];
  chrArray = this.chromosomesArray;

  for (i = 0; i < chrArray.length; i++) {
    chr = chrArray[i].name;
    chrs.push(chr);
    filledAnnots.push({chr: chr, annots: []});
  }

  for (i = 0; i < annots.length; i++) {
    annot = annots[i];
    chrIndex = chrs.indexOf(annot.chr);
    if (chrIndex !== -1) {
      filledAnnots[chrIndex] = annot;
    }
  }

  return filledAnnots;
}

export {
  onLoadAnnots, onDrawAnnots, processAnnotData, restoreDefaultTracks,
  updateDisplayedTracks, initAnnotSettings, fetchAnnots, drawAnnots,
  getHistogramBars, drawHeatmaps, deserializeAnnotsForHeatmap, fillAnnots,
  drawProcessedAnnots, drawSynteny, startHideAnnotTooltipTimeout,
  showAnnotTooltip, onWillShowAnnotTooltip, setOriginalTrackIndexes,
  afterRawAnnots, onClickAnnot, downloadAnnotations, addAnnotLabel,
  removeAnnotLabel, fillAnnotLabels, clearAnnotLabels
  // fadeOutAnnotLabels
};
