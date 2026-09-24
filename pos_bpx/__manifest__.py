{
    'name': 'POS BPX',
    'version': '19.0.1.0.0',
    'category': 'Point of Sale',
    'depends': ['web', 'point_of_sale'],
    'data': ['views/pos_order_views.xml'],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_bpx/static/src/overrides/bpx.js',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
}
