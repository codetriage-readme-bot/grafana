///<reference path="../../../headers/common.d.ts" />

import './graph';
import './legend';
import './series_overrides_ctrl';
import './thresholds_form';

import template from './template';
import angular from 'angular';
import moment from 'moment';
import kbn from 'app/core/utils/kbn';
import _ from 'lodash';
import TimeSeries from 'app/core/time_series2';
import config from 'app/core/config';
import * as fileExport from 'app/core/utils/file_export';
import {MetricsPanelCtrl, alertTab} from 'app/plugins/sdk';

class GraphCtrl extends MetricsPanelCtrl {
  static template = template;

  hiddenSeries: any = {};
  seriesList: any = [];
  logScales: any;
  unitFormats: any;
  xAxisModes: any;
  xAxisSeriesValues: any;
  xAxisColumns: any = [];
  annotationsPromise: any;
  datapointsCount: number;
  datapointsOutside: boolean;
  datapointsWarning: boolean;
  colors: any = [];
  subTabIndex: number;

  panelDefaults = {
    // datasource name, null = default datasource
    datasource: null,
    // sets client side (flot) or native graphite png renderer (png)
    renderer: 'flot',
    yaxes: [
      {
        label: null,
        show: true,
        logBase: 1,
        min: null,
        max: null,
        format: 'short'
      },
      {
        label: null,
        show: true,
        logBase: 1,
        min: null,
        max: null,
        format: 'short'
      }
    ],
    xaxis: {
      show: true,
      mode: 'time',
      seriesValue: 'avg'
    },
    alert: {
      warn: {op: '>', value: undefined},
      crit: {op: '>', value: undefined},
    },
    // show/hide lines
    lines         : true,
    // fill factor
    fill          : 1,
    // line width in pixels
    linewidth     : 2,
    // show hide points
    points        : false,
    // point radius in pixels
    pointradius   : 5,
    // show hide bars
    bars          : false,
    // enable/disable stacking
    stack         : false,
    // stack percentage mode
    percentage    : false,
    // legend options
    legend: {
      show: true, // disable/enable legend
      values: false, // disable/enable legend values
      min: false,
      max: false,
      current: false,
      total: false,
      avg: false
    },
    // how null points should be handled
    nullPointMode : 'connected',
    // staircase line mode
    steppedLine: false,
    // tooltip options
    tooltip       : {
      value_type: 'cumulative',
      shared: true,
      sort: 0,
      msResolution: false,
    },
    // time overrides
    timeFrom: null,
    timeShift: null,
    // metric queries
    targets: [{}],
    // series color overrides
    aliasColors: {},
    // other style overrides
    seriesOverrides: [],
    alerting: {},
    thresholds: [],
  };

  /** @ngInject */
  constructor($scope, $injector, private annotationsSrv) {
    super($scope, $injector);

    _.defaults(this.panel, this.panelDefaults);
    _.defaults(this.panel.tooltip, this.panelDefaults.tooltip);
    _.defaults(this.panel.alert, this.panelDefaults.alert);
    _.defaults(this.panel.legend, this.panelDefaults.legend);
    _.defaults(this.panel.xaxis, this.panelDefaults.xaxis);

    this.colors = $scope.$root.colors;

    this.events.on('render', this.onRender.bind(this));
    this.events.on('data-received', this.onDataReceived.bind(this));
    this.events.on('data-error', this.onDataError.bind(this));
    this.events.on('data-snapshot-load', this.onDataSnapshotLoad.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('init-panel-actions', this.onInitPanelActions.bind(this));
  }

  onInitEditMode() {
    this.addEditorTab('Axes', 'public/app/plugins/panel/graph/tab_axes.html', 2);
    this.addEditorTab('Legend', 'public/app/plugins/panel/graph/tab_legend.html', 3);
    this.addEditorTab('Display', 'public/app/plugins/panel/graph/tab_display.html', 4);

    if (config.alertingEnabled) {
      this.addEditorTab('Alert', alertTab, 5);
    }

    this.logScales = {
      'linear': 1,
      'log (base 2)': 2,
      'log (base 10)': 10,
      'log (base 32)': 32,
      'log (base 1024)': 1024
    };
    this.unitFormats = kbn.getUnitFormats();

    this.xAxisModes = {
      'Time': 'time',
      'Series': 'series',
      'Table': 'table',
      'Elastic Raw Doc': 'elastic'
    };

    this.xAxisSeriesValues = ['min', 'max', 'avg', 'current', 'total'];
    this.subTabIndex = 0;
  }

  onInitPanelActions(actions) {
    actions.push({text: 'Export CSV (series as rows)', click: 'ctrl.exportCsv()'});
    actions.push({text: 'Export CSV (series as columns)', click: 'ctrl.exportCsvColumns()'});
    actions.push({text: 'Toggle legend', click: 'ctrl.toggleLegend()'});
  }

  setUnitFormat(axis, subItem) {
    axis.format = subItem.value;
    this.render();
  }

  issueQueries(datasource) {
    this.annotationsPromise = this.annotationsSrv.getAnnotations(this.dashboard);
    return super.issueQueries(datasource);
  }

  zoomOut(evt) {
    this.publishAppEvent('zoom-out', 2);
  }

  onDataSnapshotLoad(snapshotData) {
    this.annotationsPromise = this.annotationsSrv.getAnnotations(this.dashboard);
    this.onDataReceived(snapshotData);
  }

  onDataError(err) {
    this.seriesList = [];
    this.render([]);
  }

  onDataReceived(dataList) {
    this.datapointsWarning = false;
    this.datapointsCount = 0;
    this.datapointsOutside = false;

    let dataHandler: (seriesData, index)=>any;
    if (this.panel.xaxis.mode === 'table') {
      if (dataList.length) {
        // Table panel uses only first enabled tagret, so we can use dataList[0]
        // for table data representation
        dataList.splice(1, dataList.length - 1);
        this.xAxisColumns = _.map(dataList[0].columns, (column, index) => {
          return {
            text: column.text,
            index: index
          };
        });

        // Set last column as default value
        if (!this.panel.xaxis.valueColumnIndex) {
          this.panel.xaxis.valueColumnIndex = this.xAxisColumns.length - 1;
        }
      }

      dataHandler = this.tableHandler;
    } else if (this.panel.xaxis.mode === 'elastic') {
      if (dataList.length) {
        dataList.splice(1, dataList.length - 1);
        var point = _.first(dataList[0].datapoints);
        this.xAxisColumns = getFieldsFromESDoc(point);
      }

      dataHandler = this.esRawDocHandler;
    } else {
      dataHandler = this.timeSeriesHandler;
    }

    this.seriesList = dataList.map(dataHandler.bind(this));
    this.datapointsWarning = this.datapointsCount === 0 || this.datapointsOutside;

    this.annotationsPromise.then(annotations => {
      this.loading = false;
      this.seriesList.annotations = annotations;
      this.render(this.seriesList);
    }, () => {
      this.loading = false;
      this.render(this.seriesList);
    });
  }

  seriesHandler(seriesData, index, datapoints, alias) {
    var colorIndex = index % this.colors.length;
    var color = this.panel.aliasColors[alias] || this.colors[colorIndex];

    var series = new TimeSeries({
      datapoints: datapoints,
      alias: alias,
      color: color,
      unit: seriesData.unit,
    });

    if (datapoints && datapoints.length > 0) {
      var last = moment.utc(datapoints[datapoints.length - 1][1]);
      var from = moment.utc(this.range.from);
      if (last - from < -10000) {
        this.datapointsOutside = true;
      }

      this.datapointsCount += datapoints.length;
      this.panel.tooltip.msResolution = this.panel.tooltip.msResolution || series.isMsResolutionNeeded();
    }

    return series;
  }

  timeSeriesHandler(seriesData, index) {
    var datapoints = seriesData.datapoints;
    var alias = seriesData.target;

    return this.seriesHandler(seriesData, index, datapoints, alias);
  }

  tableHandler(seriesData, index) {
    var xColumnIndex = Number(this.panel.xaxis.columnIndex);
    var valueColumnIndex = Number(this.panel.xaxis.valueColumnIndex);
    var datapoints = _.map(seriesData.rows, (row) => {
      var value = valueColumnIndex ? row[valueColumnIndex] : _.last(row);
      return [
        value,             // Y value
        row[xColumnIndex]  // X value
      ];
    });

    var alias = seriesData.columns[valueColumnIndex].text;

    return this.seriesHandler(seriesData, index, datapoints, alias);
  }

  esRawDocHandler(seriesData, index) {
    let xField = this.panel.xaxis.esField;
    let valueField = this.panel.xaxis.esValueField;
    let datapoints = _.map(seriesData.datapoints, (doc) => {
      return [
        pluckDeep(doc, valueField),  // Y value
        pluckDeep(doc, xField)       // X value
      ];
    });

    // Remove empty points
    datapoints = _.filter(datapoints, (point) => {
      return point[0] !== undefined;
    });

    var alias = valueField;

    return this.seriesHandler(seriesData, index, datapoints, alias);
  }

  onRender() {
    if (!this.seriesList) { return; }

    for (let series of this.seriesList) {
      series.applySeriesOverrides(this.panel.seriesOverrides);

      if (series.unit) {
        this.panel.yaxes[series.yaxis-1].format = series.unit;
      }
    }
  }

  changeSeriesColor(series, color) {
    series.color = color;
    this.panel.aliasColors[series.alias] = series.color;
    this.render();
  }

  toggleSeries(serie, event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (this.hiddenSeries[serie.alias]) {
        delete this.hiddenSeries[serie.alias];
      } else {
        this.hiddenSeries[serie.alias] = true;
      }
    } else {
      this.toggleSeriesExclusiveMode(serie);
    }
    this.render();
  }

  toggleSeriesExclusiveMode (serie) {
    var hidden = this.hiddenSeries;

    if (hidden[serie.alias]) {
      delete hidden[serie.alias];
    }

    // check if every other series is hidden
    var alreadyExclusive = _.every(this.seriesList, value => {
      if (value.alias === serie.alias) {
        return true;
      }

      return hidden[value.alias];
    });

    if (alreadyExclusive) {
      // remove all hidden series
      _.each(this.seriesList, value => {
        delete this.hiddenSeries[value.alias];
      });
    } else {
      // hide all but this serie
      _.each(this.seriesList, value => {
        if (value.alias === serie.alias) {
          return;
        }

        this.hiddenSeries[value.alias] = true;
      });
    }
  }

  toggleAxis(info) {
    var override = _.findWhere(this.panel.seriesOverrides, {alias: info.alias});
    if (!override) {
      override = { alias: info.alias };
      this.panel.seriesOverrides.push(override);
    }
    info.yaxis = override.yaxis = info.yaxis === 2 ? 1 : 2;
    this.render();
  };

  addSeriesOverride(override) {
    this.panel.seriesOverrides.push(override || {});
  }

  removeSeriesOverride(override) {
    this.panel.seriesOverrides = _.without(this.panel.seriesOverrides, override);
    this.render();
  }

  // Called from panel menu
  toggleLegend() {
    this.panel.legend.show = !this.panel.legend.show;
    this.refresh();
  }


  legendValuesOptionChanged() {
    var legend = this.panel.legend;
    legend.values = legend.min || legend.max || legend.avg || legend.current || legend.total;
    this.render();
  }

  exportCsv() {
    fileExport.exportSeriesListToCsv(this.seriesList);
  }

  exportCsvColumns() {
    fileExport.exportSeriesListToCsvColumns(this.seriesList);
  }

}

function getFieldsFromESDoc(doc) {
  let fields = [];
  let fieldNameParts = [];

  function getFieldsRecursive(obj) {
    _.forEach(obj, (value, key) => {
      if (_.isObject(value)) {
        fieldNameParts.push(key);
        getFieldsRecursive(value);
      } else {
        let field = fieldNameParts.concat(key).join('.');
        fields.push(field);
      }
    });
    fieldNameParts.pop();
  }

  getFieldsRecursive(doc);
  return fields;
}

function pluckDeep(obj: any, property: string) {
  let propertyParts = property.split('.');
  let value = obj;
  for (let i = 0; i < propertyParts.length; ++i) {
    if (value[propertyParts[i]]) {
      value = value[propertyParts[i]];
    } else {
      return undefined;
    }
  }
  return value;
}

export {GraphCtrl, GraphCtrl as PanelCtrl}