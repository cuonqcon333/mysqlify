import { Model } from '@caplab/mysqlify';

export class {{ModelName}} extends Model {
  static table = '{{table}}';
  static primaryKey = 'id';
  static timestamps = true;
  static softDelete = false;

  static fillable = [
    // 'column_name',
  ];

  static guarded = [];

  static hidden = [
    // 'password',
  ];
}
